/**
 * Razorpay, hand-rolled. The gateway's REST API is plain JSON over HTTPS with HTTP Basic auth, so the official npm
 * package would buy nothing but a dependency; this file is node:crypto and fetch and that is the whole integration.
 *
 * DEMO MODE. A hackathon laptop has no merchant account, so with RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET unset this
 * module mints an order id of its own ("order_demo_…") and lets a settlement through without a signature — the
 * bill, the commission split and the worker's wallet all work, but no money moves. That is a deliberate hole, so
 * it is fenced in three ways: it is decided ONLY by the absence of keys (no flag, header or body field can ask for
 * it), every order it mints is stamped provider: "demo" so the screens can say so, and the moment real keys exist
 * every verify call goes through the real HMAC. lib/payments.ts adds a fourth fence: it only skips verification for
 * a payment that was itself created in demo mode.
 *
 * Signatures are compared with timingSafeEqual over equal-length buffers — it throws on a length mismatch, and a
 * plain === would leak, through its early return, how much of the signature an attacker has guessed correctly.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const API = "https://api.razorpay.com/v1";

export class PaymentError extends Error {
  constructor(public code: "gateway_unavailable" | "signature_invalid", message: string) { super(message); }
}

const keyId = () => process.env.RAZORPAY_KEY_ID?.trim() || "";
const keySecret = () => process.env.RAZORPAY_KEY_SECRET?.trim() || "";
const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
const timeoutMs = () => { const n = Number(process.env.RAZORPAY_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 12_000; };

/** True only when BOTH halves of the key pair are present: half a key pair is a misconfiguration, not live mode. */
export function razorpayConfigured(): boolean {
  return !!(keyId() && keySecret());
}

/** The key id is public by design (Checkout needs it in the browser); the secret never leaves this module. */
export function publicKeyId(): string | null {
  return razorpayConfigured() ? keyId() : null;
}

export type GatewayOrder = { orderId: string; amountPaise: number; provider: "razorpay" | "demo"; status: string };

/**
 * Open an order for `amountPaise` (Razorpay is paise-denominated too, so the integer travels unchanged).
 * `receipt` is our own reference and the API caps it at 40 characters; `notes` is a string map echoed back to us on
 * the webhook. Throws PaymentError("gateway_unavailable") for a timeout, a network error or any non-order answer —
 * the caller reports "try again", never a half-open order.
 */
export async function createOrder(input: { amountPaise: number; receipt: string; notes?: Record<string, string> }): Promise<GatewayOrder> {
  const amountPaise = input.amountPaise;
  // Defensive: a non-integer amount means a bug upstream of lib/money.ts, and must never reach a payment gateway.
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new PaymentError("gateway_unavailable", "refusing to open an order for a non-integer amount");
  if (!razorpayConfigured()) return { orderId: `order_demo_${randomUUID()}`, amountPaise, provider: "demo", status: "created" };

  const auth = Buffer.from(`${keyId()}:${keySecret()}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: input.receipt.slice(0, 40), notes: input.notes ?? {} }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    throw new PaymentError("gateway_unavailable", `razorpay unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown; amount?: unknown; status?: unknown } | null;
  if (!res.ok || typeof body?.id !== "string" || !body.id) throw new PaymentError("gateway_unavailable", `razorpay declined the order (HTTP ${res.status})`);
  // An order for an amount we did not ask for is worse than no order: bill the customer only what we computed.
  if (typeof body.amount === "number" && body.amount !== amountPaise) throw new PaymentError("gateway_unavailable", "razorpay opened the order for a different amount");
  return { orderId: body.id, amountPaise, provider: "razorpay", status: typeof body.status === "string" ? body.status : "created" };
}

/** Razorpay Checkout's callback signature: HMAC-SHA256 of `order_id|payment_id`, keyed with the API secret. */
export function verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature?: string | null }): void {
  if (!razorpayConfigured()) return; // demo mode: there is no secret to sign with, and no money to protect
  const expected = createHmac("sha256", keySecret()).update(`${input.orderId}|${input.paymentId}`).digest("hex");
  if (!sameSignature(expected, input.signature)) throw new PaymentError("signature_invalid", "checkout signature does not match");
}

/**
 * Webhook signature: HMAC-SHA256 of the RAW request body, keyed with the webhook secret (a different secret from
 * the API key). The body must be the bytes as they arrived — re-serialising parsed JSON reorders keys and the
 * digest stops matching.
 */
export function verifyWebhookSignature(rawBody: string, signature?: string | null): void {
  // NO demo bypass here, deliberately. The webhook is unauthenticated by construction: it carries no session, and
  // the order id it quotes is visible to the worker through /api/payments/bill. If an unsigned webhook were
  // honoured whenever keys happen to be blank, a worker could settle the customer's order and credit their own
  // wallet with one curl. With no secret configured there is no way to tell Razorpay from anyone else, so the only
  // safe answer is to refuse — demo settlement goes through the browser callback, which at least had a session.
  const secret = webhookSecret();
  // Live keys with no webhook secret: we cannot tell Razorpay from anyone else, so we trust nobody.
  if (!secret) throw new PaymentError("signature_invalid", "RAZORPAY_WEBHOOK_SECRET is not configured; refusing an unverifiable webhook");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (!sameSignature(expected, signature)) throw new PaymentError("signature_invalid", "webhook signature does not match");
}

function sameSignature(expectedHex: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(given.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b); // length check first: timingSafeEqual throws on a mismatch
}
