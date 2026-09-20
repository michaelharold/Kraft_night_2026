/**
 * Helper ranking (README §5, docs/UPGRADE.md §3 + §5). Pure functions: no store, no I/O, `now` passed in.
 *   score = 0.45*capabilityMatch + 0.30*proximity + 0.15*reliability + 0.10*recency
 *   capabilityMatch = (|neededSkills ∩ skills| + |neededEquipment ∩ equipment|) / (|neededSkills| + |neededEquipment|)
 *   proximity = max(0, 1 - d/radius); recency = 1 if lastSeen < 10 min else 0.5
 * With no needed equipment, capabilityMatch equals the original skillMatch, so old callers score exactly as before.
 */
import type { Equipment, Helper, HelpRequest, LatLng, Skill, TrustTier } from "./types";

export const WAVE_RADII_KM = [1, 2, 4, 8] as const;
export const MAX_WAVES = 4;
export const PINGS_PER_WAVE = 3;
export const TICK_GRACE_MS = 1000;
export const RECENCY_WINDOW_MS = 10 * 60_000;
export const INITIAL_RELIABILITY = 0.7;
export const SEED_CENTER_DEFAULT: LatLng = { lat: 8.913, lng: 76.635 };

// Literals (not imports) so this module keeps zero runtime dependencies; same values as lib/policy.ts.
const TIER_1: TrustTier = "TIER_1_NEIGHBOR";
const TIER_3: TrustTier = "TIER_3_FIRST_RESPONDER";
const tier = (h: Pick<Helper, "trustTier">): TrustTier => h.trustTier ?? TIER_1;

export function waveWindowMs(): number {
  const n = Number(process.env.RESQ_WAVE_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export function getSeedCenter(): LatLng {
  const lat = Number(process.env.SEED_CENTER_LAT);
  const lng = Number(process.env.SEED_CENTER_LNG);
  return process.env.SEED_CENTER_LAT && process.env.SEED_CENTER_LNG && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : SEED_CENTER_DEFAULT;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How much of what the situation needs this helper can cover, 0..1: skills they have AND equipment they own
 * ("Basement flooded, need pump" reaches the neighbour who owns a water pump even if they are not a plumber).
 */
export function capabilityMatch(i: { helper: Pick<Helper, "skills" | "equipment">; neededSkills: Skill[]; neededEquipment?: Equipment[] }): number {
  const skills = [...new Set(i.neededSkills)];
  const equipment = [...new Set(i.neededEquipment ?? [])];
  const total = skills.length + equipment.length;
  if (total === 0) return 0;
  const owned = i.helper.equipment ?? [];
  return (skills.filter((s) => i.helper.skills.includes(s)).length + equipment.filter((e) => owned.includes(e)).length) / total;
}

export function scoreHelper(i: { helper: Helper; needed: Skill[]; neededEquipment?: Equipment[]; distanceKm: number; radiusKm: number; now: Date }): {
  score: number;
  skillMatch: number; // skills only (unchanged meaning)
  capabilityMatch: number; // skills + equipment; this is what the score uses
} {
  const needed = [...new Set(i.needed)];
  const skillMatch = needed.length ? needed.filter((s) => i.helper.skills.includes(s)).length / needed.length : 0;
  const capability = capabilityMatch({ helper: i.helper, neededSkills: needed, neededEquipment: i.neededEquipment });
  const proximity = Math.max(0, 1 - i.distanceKm / i.radiusKm);
  const seen = Date.parse(i.helper.lastSeen);
  const recency = Number.isFinite(seen) && i.now.getTime() - seen < RECENCY_WINDOW_MS ? 1 : 0.5;
  return { score: 0.45 * capability + 0.3 * proximity + 0.15 * i.helper.reliability + 0.1 * recency, skillMatch, capabilityMatch: capability };
}

/**
 * Picks who is pinged in one wave (at most PINGS_PER_WAVE, inside radiusKm, on duty, not excluded).
 *
 * - Eligible = capabilityMatch > 0 (a needed skill OR a needed piece of equipment). Eligible helpers rank by score.
 * - Default (free life-safety requests): if fewer than PINGS_PER_WAVE are eligible, the wave is filled with the
 *   nearest other helpers, because a bystander beats nobody.
 * - `strict` (paid micro-gigs): no fill, and a matching SKILL is required: owning the tool does not make someone
 *   the tradesperson the requester is paying for (equipment still raises the score).
 * - `requireTier`: only helpers holding exactly that trust tier are considered.
 * - `prioritizeTier3`: stable partition that moves TIER_3_FIRST_RESPONDER helpers to the front of the eligible
 *   group (and of the fill group), keeping score / distance order inside each part. Capability still comes first:
 *   a Tier-3 helper with no match never displaces an eligible helper.
 */
export function selectWave(i: {
  request: HelpRequest;
  helpers: Helper[];
  radiusKm: number;
  excludeHelperIds: Set<string>;
  now: Date;
  neededEquipment?: Equipment[];
  prioritizeTier3?: boolean;
  requireTier?: TrustTier;
  strict?: boolean;
}): Array<{ helper: Helper; score: number; distanceKm: number }> {
  const { location, triage } = i.request;
  if (!location || !triage) return [];
  const candidates = i.helpers
    .filter((h) => h.onDuty && h.location && !i.excludeHelperIds.has(h.id))
    .filter((h) => i.requireTier === undefined || tier(h) === i.requireTier)
    .map((helper) => {
      const distanceKm = haversineKm(location, helper.location as LatLng);
      const s = scoreHelper({ helper, needed: triage.skills, neededEquipment: i.neededEquipment, distanceKm, radiusKm: i.radiusKm, now: i.now });
      return { helper, distanceKm, score: s.score, skillMatch: s.skillMatch, capabilityMatch: s.capabilityMatch };
    })
    .filter((c) => c.distanceKm <= i.radiusKm);

  type Candidate = (typeof candidates)[number];
  const tier3First = (list: Candidate[]) =>
    i.prioritizeTier3 ? [...list.filter((c) => tier(c.helper) === TIER_3), ...list.filter((c) => tier(c.helper) !== TIER_3)] : list;

  const eligible = candidates
    .filter((c) => (i.strict ? c.skillMatch > 0 : c.capabilityMatch > 0))
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm || a.helper.id.localeCompare(b.helper.id));
  const fill = i.strict
    ? []
    : candidates.filter((c) => c.capabilityMatch === 0).sort((a, b) => a.distanceKm - b.distanceKm || a.helper.id.localeCompare(b.helper.id));

  return [...tier3First(eligible), ...tier3First(fill)]
    .slice(0, PINGS_PER_WAVE)
    .map(({ helper, score, distanceKm }) => ({ helper, score, distanceKm }));
}
