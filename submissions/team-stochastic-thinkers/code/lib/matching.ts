/**
 * AI matching engine: available providers within 10 km whose skills match the AI's tags and who carry the
 * required tools. MongoDB does the spatial work on `users.geo` (2dsphere, GeoJSON [lng, lat]):
 *   1. toolsOnHand $all requiredTools   → "all"   (has every tool)
 *   2. toolsOnHand $in  requiredTools   → "any"   (has some of them)
 *   3. skills only                      → "skills_only"
 * Results are cross-checked with the live engine (available for work, not already on a job) and tagged with
 * isAppOnline so dispatch can choose app notification (SSE) or SMS.
 *
 * VERIFICATION RANKS, IT DOES NOT EXCLUDE. This filter used to require `idProof.status === "verified"`, which
 * silently removed every unverified provider from every AI-scoped job — they were never matched, never texted,
 * and had no way to tell. That is the opposite of what the product is for: someone signs up to earn from their
 * skills and then never hears about a single job. It also disagreed with the non-AI path, which has no such
 * filter, so the same worker existed or did not depending on which button the customer pressed.
 *
 * Verified providers are returned first, and the customer sees an "ID verified" badge against each name before
 * they choose. Trust belongs in that decision, not in a silent database filter.
 */
import { getDb } from "./mongodb";
import { getStore } from "./store";
import { haversineKm } from "./dispatch";
import { isAppOnline } from "./presence";
import { rateFor } from "./policy";
import { busyHelperIds } from "./waves";
import type { Helper, LatLng, LanguageCode, RateRange, TaskScope, Tool } from "./types";

export const MATCH_RADIUS_M = 10_000;
export type MatchedWorker = {
  id: string; name: string; phone: string; distanceKm: number; toolsMatched: Tool[]; toolsMissing: Tool[];
  online: boolean; rate: RateRange | null; language: LanguageCode | null;
};
export type MatchResult = {
  workers: MatchedWorker[];
  toolMatch: "all" | "any" | "skills_only" | "none";
  /** Why nobody matched, when nobody did — so the screen can say it instead of looking broken. */
  emptyReason?: "none_nearby" | "all_busy" | "all_off_duty";
};

type UserDoc = Helper & { _id: string };

export async function findMatchingWorkers(i: { location: LatLng; scope: TaskScope; excludeId: string; limit?: number }): Promise<MatchResult> {
  const users = (await getDb()).collection<UserDoc>("users");
  const base = {
    geo: { $near: { $geometry: { type: "Point", coordinates: [i.location.lng, i.location.lat] }, $maxDistance: MATCH_RADIUS_M } },
    skills: { $in: i.scope.workerMatchingTags },          // specializations / service category
    _id: { $ne: i.excludeId },
  };
  const tools = i.scope.requiredTools;
  const tiers: [MatchResult["toolMatch"], Record<string, unknown>][] = tools.length
    ? [["all", { ...base, toolsOnHand: { $all: tools } }], ["any", { ...base, toolsOnHand: { $in: tools } }], ["skills_only", base]]
    : [["skills_only", base]];

  const store = getStore();
  const busy = await busyHelperIds();
  let skippedBusy = 0, skippedOff = 0;
  for (const [tier, filter] of tiers) {
    const docs = await users.find(filter as never).limit(i.limit ?? 25).toArray(); // $near already sorts by distance
    const workers: MatchedWorker[] = [];
    const unverified: MatchedWorker[] = [];
    for (const d of docs) {
      const live = await store.getHelper(d._id); // the live engine knows who is available right now
      if (!live) continue;
      if (busy.has(live.id)) { skippedBusy++; continue; }          // already on a job — one job at a time
      if (!live.onDuty || !live.location) { skippedOff++; continue; }
      const have = live.toolsOnHand ?? [];
      const w: MatchedWorker = {
        id: live.id, name: live.name, phone: live.phone, distanceKm: +haversineKm(i.location, live.location).toFixed(2),
        toolsMatched: tools.filter((t) => have.includes(t)), toolsMissing: tools.filter((t) => !have.includes(t)),
        online: isAppOnline(live.id), rate: rateFor(live, i.scope.category), language: live.language ?? null,
      };
      (live.idProof?.status === "verified" ? workers : unverified).push(w);
    }
    // Verified first, then everyone else — but everyone else is still HERE. See the note at the top of the file.
    const all = [...workers, ...unverified];
    if (all.length) return { workers: all, toolMatch: tier };
  }
  // Nobody matched. Say which kind of nobody, because "no providers" and "every provider is mid-job" are very
  // different facts and the second one looks exactly like a broken dispatcher from the outside.
  const emptyReason = skippedBusy > 0 ? "all_busy" : skippedOff > 0 ? "all_off_duty" : "none_nearby";
  console.log(`[match] no workers (${emptyReason}; ${skippedBusy} busy, ${skippedOff} off duty)`);
  return { workers: [], toolMatch: "none", emptyReason };
}
