/**
 * In-memory escrow for paid household micro-gigs (docs/UPGRADE.md §1). No real payment rails: the callout fee is
 * "held" on the request (escrowStatus HELD) and, once the job is resolved, credited to the helper's walletBalance.
 *
 * releaseEscrowLocked() does NOT take the request lock: the caller must already hold withRequestLock(requestId)
 * (lib/waves.ts resolve() and payout()). That lock is not re-entrant, which is why this lives in its own module.
 * Holding the request lock is what makes the release idempotent: HELD → RELEASED happens once, so a double
 * payout call (or resolve + payout racing) can never credit twice.
 */
import { emit } from "./events";
import { getStore } from "./store";
import { categoryOf, feeOf, walletOf } from "./policy";
import type { Helper, HelpRequest } from "./types";

export type EscrowFailReason = "not_found" | "not_microgig" | "refunded" | "not_resolved" | "no_helper";
export type EscrowRelease =
  | { ok: true; escrowStatus: "RELEASED"; amount: number; helperId: string; walletBalance: number; alreadyReleased: boolean; request: HelpRequest; helper: Helper | null }
  | { ok: false; reason: EscrowFailReason };

const g = globalThis as unknown as { __resq_wallet_locks?: Map<string, Promise<unknown>> };
const walletLocks = (g.__resq_wallet_locks ??= new Map());

/**
 * Serialises read-modify-write updates of ONE helper record (wallet credit, rating, profile save), so a credit for
 * request A cannot be lost to a concurrent write that started from a stale copy of the helper. Lock order is always
 * request lock → helper lock; never take a request lock inside this.
 */
export function withHelperLock<T>(helperId: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(helperId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  walletLocks.set(helperId, tail);
  void tail.then(() => { if (walletLocks.get(helperId) === tail) walletLocks.delete(helperId); });
  return run;
}

/** Call ONLY while holding withRequestLock(requestId). */
export async function releaseEscrowLocked(requestId: string): Promise<EscrowRelease> {
  const store = getStore();
  const r = await store.getRequest(requestId);
  if (!r) return { ok: false, reason: "not_found" };
  if (categoryOf(r) !== "HOUSEHOLD_MICROGIG") return { ok: false, reason: "not_microgig" };
  if (r.escrowStatus === "REFUNDED") return { ok: false, reason: "refunded" };
  const amount = feeOf(r);

  if (r.escrowStatus === "RELEASED") {
    // Idempotent replay: report the current balance, credit nothing.
    const helper = r.matchedHelperId ? await store.getHelper(r.matchedHelperId) : null;
    return { ok: true, escrowStatus: "RELEASED", amount, helperId: r.matchedHelperId ?? "", walletBalance: walletOf(helper), alreadyReleased: true, request: r, helper };
  }

  if (r.status !== "resolved") return { ok: false, reason: "not_resolved" };
  const helperId = r.matchedHelperId;
  if (!helperId) return { ok: false, reason: "no_helper" };

  const helper = await withHelperLock(helperId, async () => {
    const h = await store.getHelper(helperId);
    return h ? store.upsertHelper({ ...h, walletBalance: walletOf(h) + amount }) : null;
  });
  if (!helper) return { ok: false, reason: "no_helper" };
  const request = (await store.updateRequest(requestId, { escrowStatus: "RELEASED" })) as HelpRequest;
  emit("helper:updated", { helper });
  emit("request:updated", { request });
  return { ok: true, escrowStatus: "RELEASED", amount, helperId, walletBalance: walletOf(helper), alreadyReleased: false, request, helper };
}
