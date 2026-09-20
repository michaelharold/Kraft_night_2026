/**
 * GET /api/payments/bill?requestId=… — the itemised bill, readable by the two people it concerns (and by ops, the
 * same rule GET /api/requests/:id already applies). It is recomputed per call, so it always reflects the receipts
 * the customer has approved so far, and it is answered even before the worker has named a charge — `settlement` is
 * then null, which is the UI's cue to say "waiting for the worker's final amount" instead of showing a total.
 */
import { hasIdentity, requestAccess } from "@/lib/access";
import { billFor } from "@/lib/payments";
import { getStore } from "@/lib/store";
import { isUid, json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const requestId = new URL(req.url).searchParams.get("requestId");
  if (!isUid(requestId)) return jsonError(400, "requestId_invalid");
  const r = await getStore().getRequest(requestId);
  if (!r) return jsonError(404, "not_found");
  const who = requestAccess(req, r);
  if (!who) return jsonError(hasIdentity(req) ? 403 : 401, hasIdentity(req) ? "forbidden" : "unauthenticated");
  const res = await billFor(requestId);
  if (!res.ok) return jsonError(res.reason === "not_found" ? 404 : 409, res.reason);
  return json({ ok: true, who, bill: res.bill });
});
