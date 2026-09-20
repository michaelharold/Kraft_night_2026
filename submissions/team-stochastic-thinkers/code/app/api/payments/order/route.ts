/**
 * POST /api/payments/order { requestId } — the customer opens a Razorpay order for the current bill and gets back
 * what Checkout needs: the order id, the amount in paise and the public key id. `provider` is the field the UI must
 * read: "demo" means no keys are configured, so the screen has to say that no real money will move.
 */
import { getHelperSession } from "@/lib/auth";
import { openOrder, type OrderResult } from "@/lib/payments";
import { isUid, json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";
type Reason = Extract<OrderResult, { ok: false }>["reason"];
const STATUS: Record<Reason, number> = {
  not_found: 404, not_service: 409, forbidden: 403, not_resolved: 409, amount_not_set: 409, already_paid: 409, no_worker: 409, gateway_unavailable: 503,
};

export const POST = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const requestId = body.value.requestId;
  if (!isUid(requestId)) return jsonError(400, "requestId_invalid");

  const res = await openOrder(requestId, s.helperId);
  if (!res.ok) return jsonError(STATUS[res.reason], res.reason);
  return json({
    ok: true, orderId: res.orderId, amountPaise: res.amountPaise, currency: "INR",
    keyId: res.keyId, provider: res.provider, reused: res.reused, paymentId: res.payment.id, bill: res.bill,
  });
});
