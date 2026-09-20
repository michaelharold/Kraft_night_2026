import { getStore } from "@/lib/store";
import { hasIdentity, requestAccess } from "@/lib/access";
import { json, jsonError, readJson, safe } from "@/lib/validate";
import { payout } from "@/lib/waves";

export const dynamic = "force-dynamic";

/**
 * POST /api/incident/payout { requestId } — release a micro-gig's escrow to the helper who did the job.
 * Allowed: the requester, the matched helper, or ops. Idempotent: "Mark as done" already releases the escrow, so this
 * normally answers alreadyReleased: true; a second call never credits the wallet again.
 *   200 { ok: true, escrowStatus: "RELEASED", amount, helperId, walletBalance, alreadyReleased }
 *   409 { error: "not_resolved" | "not_microgig" | "no_helper" | "refunded" } · 404 { error: "not_found" }
 */
export const POST = safe(async (req: Request) => {
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const requestId = body.value.requestId;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 64) return jsonError(400, "requestId_invalid");
  const r = await getStore().getRequest(requestId);
  if (!r) return jsonError(hasIdentity(req) ? 404 : 401, hasIdentity(req) ? "not_found" : "unauthenticated");
  if (!requestAccess(req, r)) return jsonError(hasIdentity(req) ? 403 : 401, hasIdentity(req) ? "forbidden" : "unauthenticated");
  const res = await payout(requestId);
  if (!res.ok) return jsonError(res.reason === "not_found" ? 404 : 409, res.reason);
  return json({ ok: true, escrowStatus: res.escrowStatus, amount: res.amount, helperId: res.helperId, walletBalance: res.walletBalance, alreadyReleased: res.alreadyReleased });
});
