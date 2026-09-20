/**
 * POST /api/payments/verify — the browser's half of the confirmation, called from Razorpay Checkout's handler with
 * the three razorpay_* fields it hands back. The signature is what proves the payment, but the session is checked
 * too: in demo mode there is no signature to check, and without this an anonymous POST could settle somebody
 * else's job. The webhook settles the same payment independently; whichever arrives first credits the worker.
 */
import { getHelperSession } from "@/lib/auth";
import { settle, type SettleResult } from "@/lib/payments";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe, text } from "@/lib/validate";

export const dynamic = "force-dynamic";
type Reason = Extract<SettleResult, { ok: false }>["reason"];
const STATUS: Record<Reason, number> = { not_found: 404, payment_id_missing: 400, signature_invalid: 400, gateway_unavailable: 503 };

export const POST = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  const orderId = text(b.razorpay_order_id ?? b.orderId, 120);
  const paymentId = text(b.razorpay_payment_id ?? b.paymentId, 120);
  const signature = text(b.razorpay_signature ?? b.signature, 256);
  if (!orderId) return jsonError(400, "orderId_invalid");

  // Only the customer whose order this is may confirm it; the webhook covers the case where they close the tab.
  const payment = await getStore().getPaymentByOrderId(orderId);
  if (!payment) return jsonError(404, "not_found");
  if (payment.customerId && payment.customerId !== s.helperId) return jsonError(403, "forbidden");

  const res = await settle({ orderId, paymentId, signature, via: "checkout" });
  if (!res.ok) return jsonError(STATUS[res.reason], res.reason);
  return json({
    ok: true, alreadyPaid: res.alreadyPaid, paymentStatus: res.request?.paymentStatus ?? "paid",
    grossPaise: res.payment.grossPaise, commissionPaise: res.payment.commissionPaise, payoutPaise: res.payment.payoutPaise,
    provider: res.payment.provider,
  });
});
