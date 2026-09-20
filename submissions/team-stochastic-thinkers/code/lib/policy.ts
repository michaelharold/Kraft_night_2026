/**
 * Product rules for the upgrade: categories and callout fees (escrow), trust tiers, and the 3-minute fallback.
 * Records written before the upgrade lack the new fields, so ALWAYS read them through the accessors here.
 */
import type { Equipment, GigType, Helper, HelpRequest, NeedType, RequestCategory, Skill, TriageResult, TrustTier } from "./types";

// ── Money (in-memory demo escrow; no real payment rails) ─────────────────────────────────────────────────────
export const CURRENCY = "₹";
export const CALLOUT_FEES = [200, 500, 1000] as const;
export const formatMoney = (n: number) => `${CURRENCY}${n.toLocaleString("en-IN")}`;
export function isCalloutFee(x: unknown): x is (typeof CALLOUT_FEES)[number] {
  return typeof x === "number" && (CALLOUT_FEES as readonly number[]).includes(x);
}

// ── Categories ───────────────────────────────────────────────────────────────────────────────────────────────
export const GIG_TYPES: Record<GigType, { label: string; sub: string; skills: Skill[]; equipment: Equipment[] }> = {
  plumbing: { label: "Plumbing", sub: "Leaks, blocked drains, flooded basement", skills: ["plumber"], equipment: ["water_pump"] },
  electrical: { label: "Electrical", sub: "Wiring, fuse, inverter", skills: ["electrician"], equipment: [] },
  generator_power: { label: "Power backup", sub: "Generator, battery, outage", skills: ["generator_owner", "electrician"], equipment: [] },
  other_repair: { label: "Other repair", sub: "Carpentry, fallen tree, odd jobs", skills: ["volunteer"], equipment: ["chainsaw_cutter", "rope_ladder"] },
};
export function isGigType(x: unknown): x is GigType {
  return typeof x === "string" && x in GIG_TYPES;
}
export const categoryOf = (r: Pick<HelpRequest, "category">): RequestCategory => r.category ?? "LIFE_SAFETY";
export const feeOf = (r: Pick<HelpRequest, "category" | "calloutFee">): number => (categoryOf(r) === "HOUSEHOLD_MICROGIG" ? r.calloutFee ?? 0 : 0);

/** Need types that are always free life-safety requests, whatever the requester chose. */
export const ALWAYS_LIFE_SAFETY: NeedType[] = [
  "cardiac_no_breathing", "bleeding", "fracture", "fire", "trapped_structural", "snakebite", "flood_rescue", "evacuation_mobility", "missing_person",
];
const DANGER_WORDS = /\b(shock(ed)?|electrocut\w*|unconscious|not breathing|collapsed|burn(t|ed|ing|s)?|smoke|on fire|spark(s|ing)?|bleeding|injur\w*|trapped|drown\w*|can'?t breathe|chest pain)\b/i;
/**
 * Safety override: a request filed as a paid household job is converted to a FREE life-safety request when the
 * triage type is a life-safety type or the description mentions someone in danger. Nobody pays for an emergency.
 */
export function mustBeLifeSafety(triage: Pick<TriageResult, "type">, description: string): boolean {
  return ALWAYS_LIFE_SAFETY.includes(triage.type) || DANGER_WORDS.test(description);
}

// ── Trust tiers ──────────────────────────────────────────────────────────────────────────────────────────────
export const TRUST_TIERS = ["TIER_1_NEIGHBOR", "TIER_2_CERTIFIED_PRO", "TIER_3_FIRST_RESPONDER"] as const;
export function isTrustTier(x: unknown): x is TrustTier {
  return typeof x === "string" && (TRUST_TIERS as readonly string[]).includes(x);
}
export const tierOf = (h: Pick<Helper, "trustTier"> | null | undefined): TrustTier => h?.trustTier ?? "TIER_1_NEIGHBOR";
export const walletOf = (h: Pick<Helper, "walletBalance"> | null | undefined): number => h?.walletBalance ?? 0;
/** Service-job earnings, in PAISE. Separate from walletOf() above, which is the rupee-denominated escrow wallet. */
export const walletPaiseOf = (h: Pick<Helper, "walletPaise"> | null | undefined): number => h?.walletPaise ?? 0;
/** Paid household jobs may only be accepted by Certified Pros; free life-safety requests by anyone. */
export const REQUIRED_TIER_FOR_GIG: TrustTier = "TIER_2_CERTIFIED_PRO";
/** Skills that can take a service request: the service itself plus any extra trades the AI tagged. */
export const serviceTagsOf = (r: Partial<Pick<HelpRequest, "service" | "scope">>): Skill[] => [...new Set([...(r.service ? [r.service] : []), ...(r.scope?.workerMatchingTags ?? [])])];

export function canAccept(h: Pick<Helper, "trustTier"> & Partial<Pick<Helper, "skills">>, r: Pick<HelpRequest, "category"> & Partial<Pick<HelpRequest, "service" | "scope">>): boolean {
  const cat = categoryOf(r);
  if (cat === "SERVICE") return serviceTagsOf(r).some((t) => (h.skills ?? []).includes(t)); // providers of that service (or an AI-tagged trade)
  return cat === "LIFE_SAFETY" || tierOf(h) === REQUIRED_TIER_FOR_GIG;
}
export const isVerified = (h: Pick<Helper, "idProof"> | null | undefined): boolean => h?.idProof?.status === "verified";
export const rateFor = (h: Pick<Helper, "rates"> | null | undefined, s: Skill | null | undefined) => (s && h?.rates?.[s]) || null;

// ── 3-minute smart fallback (LIFE_SAFETY only) ───────────────────────────────────────────────────────────────
export function fallbackMs(): number {
  const n = Number(process.env.RESQ_FALLBACK_MS);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}
