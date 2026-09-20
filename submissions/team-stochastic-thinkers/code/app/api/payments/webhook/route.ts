/**
 * POST /api/payments/webhook — Razorpay's server-to-server confirmation, the half that still arrives when the
 * customer closes the tab mid-payment.
 *
 * The raw body text is read BEFORE anything parses it, because the signature is an HMAC over those exact bytes:
 * re-serialising parsed JSON reorders keys and the digest stops matching. Once the signature checks out we answer
 * 200 whatever happens next — an event we do not act on, an order we have never heard of, or a payment we already
 * settled are all "received, stop retrying"; only an unverifiable body gets a 4xx.
 */
import { settle } from "@/lib/payments";
import { PaymentError, verifyWebhookSignature } from "@/lib/razorpay";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";
const SETTLING_EVENTS = new Set(["payment.captured", "order.paid"]);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

export const POST = safe(async (req: Request) => {
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature");
  try {
    verifyWebhookSignature(raw, signature);
  } catch (e) {
    const code = e instanceof PaymentError ? e.code : "signature_invalid";
    console.error("[payments] webhook refused:", code);
    return jsonError(code === "signature_invalid" ? 400 : 503, code);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(raw);
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return json({ ok: true, handled: false, reason: "bad_json" });

  const event = str(parsed.event) ?? "";
  if (!SETTLING_EVENTS.has(event)) return json({ ok: true, handled: false, event });

  type Entity = { id?: unknown; order_id?: unknown };
  const payload = (parsed.payload ?? {}) as { payment?: { entity?: Entity }; order?: { entity?: Entity } };
  const entity = payload.payment?.entity ?? {};
  const orderId = str(entity.order_id) ?? str(payload.order?.entity?.id);
  const paymentId = str(entity.id);
  if (!orderId) return json({ ok: true, handled: false, event, reason: "no_order_id" });

  const res = await settle({ orderId, paymentId, signature, rawBody: raw, via: "webhook" });
  // A refusal here is ours to fix, not Razorpay's to retry — except a bad signature, which settle re-checks.
  if (!res.ok && res.reason === "signature_invalid") return jsonError(400, "signature_invalid");
  if (!res.ok) return json({ ok: true, handled: false, event, reason: res.reason });
  return json({ ok: true, handled: true, event, alreadyPaid: res.alreadyPaid });
});
