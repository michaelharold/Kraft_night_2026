/**
 * The money orchestration for a finished job: what the customer owes, opening a Razorpay order for it, and turning
 * a gateway confirmation into a wallet credit. lib/money.ts owns the arithmetic, lib/razorpay.ts owns the gateway,
 * the store owns the records; this file is the part that has to be right about ORDER and ONCE.
 *
 * ORDER. The worker's charge, the order and the settlement all mutate the request, so every one of them runs inside
 * withRequestLock (lib/waves.ts) — the same lock accept/resolve/payout take, which is what stops a settlement from
 * racing the escrow release. Inside it, the wallet credit takes withHelperLock (lib/escrow.ts). The nesting is
 * always request lock → helper lock and never the reverse: a helper is in exactly one job at a time here, but two
 * jobs of the same worker settling at once would deadlock if either side took the locks the other way round.
 *
 * ONCE. Razorpay announces a payment twice — the browser callback and the server webhook, in either order, plus
 * webhook retries. store.markPaymentPaid is the arbiter: exactly one caller gets alreadyPaid: false and only that
 * caller credits the worker. Every other caller reports success and credits nothing, because a second "success"
 * from the gateway is news, not money.
 *
 * The bill itself is recomputed from stored records on every read rather than cached, so a receipt the customer
 * approves between opening the screen and paying is on the bill, and one they reject is not. Reimbursement amounts
 * start life as a number a vision model read off a photograph, so they are clamped to lib/money.ts's per-receipt
 * and per-job ceilings here, on the way into the total — the itemised lines the UI shows are the clamped ones, so
 * what the customer reads always adds up to what they are charged.
 */
import { randomUUID } from "node:crypto";
import { emit } from "./events";
import { withHelperLock } from "./escrow";
import {
  MAX_REIMBURSEMENTS_PER_JOB, MAX_REIMBURSEMENT_PAISE, MAX_SERVICE_PAISE, MIN_SERVICE_PAISE,
  commissionPct, computeSettlement, formatPaise, type Settlement,
} from "./money";
import { categoryOf, walletPaiseOf } from "./policy";
import { PaymentError, createOrder, publicKeyId, razorpayConfigured, verifyCheckoutSignature, verifyWebhookSignature } from "./razorpay";
import { getStore } from "./store";
import type { HelpRequest, Payment, PaymentStatus, Reimbursement, RequestStatus } from "./types";
import { withRequestLock } from "./waves";

const nowIso = () => new Date().toISOString();

/** One line of the bill. `amountPaise` is the CLAMPED amount, so the lines always sum to the settlement. */
export type BillItem = { id: string; label: string; amountPaise: number; note: string | null; createdAt: string };

export type Bill = {
  requestId: string;
  status: RequestStatus;
  paymentStatus: PaymentStatus | null;
  customerId: string | null;
  workerId: string | null;
  servicePaise: number | null;      // null until the worker has entered their final charge
  reimbursementPaise: number;
  items: BillItem[];                // approved receipts only, oldest first
  reimbursements: Reimbursement[];  // the same records, for a UI that wants the photo or the AI's reading
  settlement: Settlement | null;    // null while servicePaise is unset: there is nothing to settle yet
  commissionPct: number;
  provider: "razorpay" | "demo";
  paid: boolean;
  paidAt: string | null;
  openOrderId: string | null;       // an order already open for this exact amount, if any
};

export type BillResult = { ok: true; bill: Bill } | { ok: false; reason: "not_found" | "not_service" };
export type ChargeResult =
  | { ok: true; request: HelpRequest; bill: Bill }
  | { ok: false; reason: "not_found" | "not_service" | "forbidden" | "wrong_status" | "already_paid" | "amount_invalid" };
export type OrderResult =
  | { ok: true; payment: Payment; orderId: string; amountPaise: number; provider: "razorpay" | "demo"; keyId: string | null; reused: boolean; bill: Bill }
  | { ok: false; reason: "not_found" | "not_service" | "forbidden" | "not_resolved" | "amount_not_set" | "already_paid" | "no_worker" | "gateway_unavailable" };
export type SettleResult =
  | { ok: true; payment: Payment; alreadyPaid: boolean; request: HelpRequest | null; walletPaise: number | null }
  | { ok: false; reason: "not_found" | "payment_id_missing" | "signature_invalid" | "gateway_unavailable" };

const provider = (): "razorpay" | "demo" => (razorpayConfigured() ? "razorpay" : "demo");
/** A stored service charge we are willing to bill. Anything else means the record predates, or dodged, the guards. */
const usableService = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= MIN_SERVICE_PAISE && (n as number) <= MAX_SERVICE_PAISE;

/** Approved receipts, clamped, capped and itemised. Rejected and still-pending claims are simply not on the bill. */
function itemise(all: Reimbursement[]): { items: BillItem[]; totalPaise: number; approved: Reimbursement[] } {
  const approved = all.filter((r) => r.status === "approved").slice(0, MAX_REIMBURSEMENTS_PER_JOB);
  const items: BillItem[] = [];
  let totalPaise = 0;
  for (const r of approved) {
    const amountPaise = Number.isSafeInteger(r.claimedPaise) && r.claimedPaise > 0 ? Math.min(r.claimedPaise, MAX_REIMBURSEMENT_PAISE) : 0;
    const merchant = r.analysis?.merchant?.trim() || null;
    items.push({ id: r.id, label: merchant ? `Parts from ${merchant}` : "Parts bought for this job", amountPaise, note: r.note, createdAt: r.createdAt });
    totalPaise += amountPaise;
  }
  return { items, totalPaise, approved };
}

/** The current bill for a job. Always readable: before the worker charges, `settlement` is null and the rest stands. */
export async function billFor(requestId: string): Promise<BillResult> {
  const store = getStore();
  const r = await store.getRequest(requestId);
  if (!r) return { ok: false, reason: "not_found" };
  if (categoryOf(r) !== "SERVICE") return { ok: false, reason: "not_service" };
  const { items, totalPaise, approved } = itemise(await store.listReimbursements(requestId));
  const pct = commissionPct();
  const servicePaise = usableService(r.servicePaise) ? r.servicePaise : null;
  const settlement = servicePaise === null ? null : computeSettlement({ servicePaise, reimbursementPaise: totalPaise, pct });
  const payments = await store.listPaymentsForRequest(requestId);
  const settled = payments.find((p) => p.status === "paid") ?? null;
  const open = settlement && payments.find((p) => p.status === "created" && p.grossPaise === settlement.grossPaise && p.provider === provider());
  return {
    ok: true,
    bill: {
      requestId, status: r.status, paymentStatus: r.paymentStatus ?? null,
      customerId: r.requesterHelperId, workerId: r.matchedHelperId,
      servicePaise, reimbursementPaise: totalPaise, items, reimbursements: approved, settlement, commissionPct: pct,
      provider: provider(), paid: !!settled, paidAt: settled?.paidAt ?? null, openOrderId: open ? open.orderId : null,
    },
  };
}

/**
 * The worker's final charge for the work, entered when they mark the job done. Allowed while the job is "matched"
 * or "resolved" and the customer has not paid; changing it invalidates any order already open for the old amount,
 * so a customer who left a checkout window sitting cannot come back and pay yesterday's figure.
 */
export async function setServiceCharge(requestId: string, workerId: string, servicePaise: number): Promise<ChargeResult> {
  const store = getStore();
  const pre = await store.getRequest(requestId);
  if (!pre) return { ok: false, reason: "not_found" };
  if (categoryOf(pre) !== "SERVICE") return { ok: false, reason: "not_service" };
  if (pre.matchedHelperId !== workerId) return { ok: false, reason: "forbidden" };
  if (!usableService(servicePaise)) return { ok: false, reason: "amount_invalid" };

  const done = await withRequestLock(requestId, async (): Promise<ChargeResult | HelpRequest> => {
    const r = await store.getRequest(requestId);
    if (!r) return { ok: false, reason: "not_found" };
    if (r.matchedHelperId !== workerId) return { ok: false, reason: "forbidden" };
    if (r.status !== "matched" && r.status !== "resolved") return { ok: false, reason: "wrong_status" };
    if (r.paymentStatus === "paid") return { ok: false, reason: "already_paid" };
    // Runs on EVERY re-charge, not only when the figure changed. Re-asserting "due" below reopens the bill to new
    // receipt approvals, so leaving an order open would let approved parts be added to a bill already being paid —
    // the customer settles the old total and the worker is never paid for the parts.
    for (const p of await store.listPaymentsForRequest(requestId)) {
      if (p.status === "created") await store.updatePayment(p.id, { status: "failed", error: "the worker re-entered the amount before this order was paid" });
    }
    // "due" is what resolve() sets; re-asserting it here takes a stale "processing" back to a payable state.
    const paymentStatus: PaymentStatus | null = r.status === "resolved" ? "due" : r.paymentStatus ?? null;
    return ((await store.updateRequest(requestId, { servicePaise, paymentStatus })) ?? r) as HelpRequest;
  });
  if ("ok" in done) return done;
  emit("request:updated", { request: done });
  const bill = await billFor(requestId);
  return bill.ok ? { ok: true, request: done, bill: bill.bill } : { ok: false, reason: bill.reason };
}

/**
 * Open a Razorpay order for the current bill. Only the customer may do this, and only once the worker has marked
 * the job done and named their charge. The gateway call happens INSIDE the request lock: a second tab opening a
 * second order for the same job is the failure this prevents, and by this point the job is resolved, so nothing
 * time-critical is waiting on that lock. An order already open for this exact amount is handed back rather than
 * duplicated.
 */
export async function openOrder(requestId: string, customerHelperId: string): Promise<OrderResult> {
  const store = getStore();
  const result = await withRequestLock(requestId, async (): Promise<OrderResult> => {
    const r = await store.getRequest(requestId);
    if (!r) return { ok: false, reason: "not_found" };
    if (categoryOf(r) !== "SERVICE") return { ok: false, reason: "not_service" };
    if (!r.requesterHelperId || r.requesterHelperId !== customerHelperId) return { ok: false, reason: "forbidden" };
    if (r.status !== "resolved") return { ok: false, reason: "not_resolved" };
    if (!usableService(r.servicePaise)) return { ok: false, reason: "amount_not_set" };
    const workerId = r.matchedHelperId;
    if (!workerId) return { ok: false, reason: "no_worker" };
    if (r.paymentStatus === "paid") return { ok: false, reason: "already_paid" };

    const bill = await billFor(requestId);
    if (!bill.ok) return { ok: false, reason: bill.reason };
    const s = bill.bill.settlement;
    if (!s) return { ok: false, reason: "amount_not_set" };
    const payments = await store.listPaymentsForRequest(requestId);
    if (payments.some((p) => p.status === "paid")) return { ok: false, reason: "already_paid" };

    const reusable = payments.filter((p) => p.status === "created" && p.grossPaise === s.grossPaise && p.provider === provider()).at(-1);
    if (reusable) {
      return { ok: true, payment: reusable, orderId: reusable.orderId, amountPaise: reusable.grossPaise, provider: reusable.provider, keyId: publicKeyId(), reused: true, bill: bill.bill };
    }

    let order;
    try {
      order = await createOrder({
        amountPaise: s.grossPaise,
        receipt: `resq_${requestId.replace(/-/g, "").slice(0, 34)}`,
        notes: { requestId, workerId, service: r.service ?? "service" },
      });
    } catch (e) {
      console.error("[payments] order failed", e instanceof PaymentError ? e.code : e);
      return { ok: false, reason: "gateway_unavailable" };
    }

    const payment = await store.createPayment({
      id: randomUUID(), requestId, customerId: r.requesterHelperId, workerId, provider: order.provider,
      orderId: order.orderId, paymentId: null, servicePaise: s.servicePaise, reimbursementPaise: s.reimbursementPaise,
      commissionPct: s.commissionPct, commissionPaise: s.commissionPaise, grossPaise: s.grossPaise, payoutPaise: s.payoutPaise,
      status: "created", error: null, createdAt: nowIso(), paidAt: null,
    });
    const request = await store.updateRequest(requestId, { paymentStatus: "processing" });
    if (request) emit("request:updated", { request });
    const after = await billFor(requestId);
    return { ok: true, payment, orderId: order.orderId, amountPaise: order.amountPaise, provider: order.provider, keyId: publicKeyId(), reused: false, bill: after.ok ? after.bill : bill.bill };
  });
  return result;
}

/**
 * Turn a gateway confirmation into money. Verifies the signature (the browser's `order_id|payment_id` HMAC, or the
 * webhook's HMAC over the raw body), then settles exactly once: the first caller credits the worker's wallet with
 * payoutPaise and flips the request to "paid"; a later caller — the other half of Razorpay's double notification —
 * gets ok: true, alreadyPaid: true and moves no money.
 *
 * Verification is skipped only for a payment that was created in demo mode AND while no keys are configured, so
 * adding real keys immediately closes the demo path for orders opened before them.
 */
export async function settle(input: { orderId: string; paymentId?: string | null; signature?: string | null; rawBody?: string; via: "checkout" | "webhook" }): Promise<SettleResult> {
  const store = getStore();
  const existing = await store.getPaymentByOrderId(input.orderId);
  if (!existing) return { ok: false, reason: "not_found" };
  // A demo payment may skip signature checks ONLY on the browser callback, which at least arrived from a session
  // that had to be the customer to open the order. The webhook is unauthenticated by construction: anyone who
  // learns an order id could POST it and move money. So a webhook always verifies, even in demo mode — where no
  // secret is configured, verification necessarily fails and the call is refused. That is the correct outcome.
  const demo = existing.provider === "demo" && !razorpayConfigured() && input.via === "checkout";

  const paymentId = (typeof input.paymentId === "string" && input.paymentId.trim()) || (demo ? `pay_demo_${randomUUID()}` : "");
  if (!paymentId) return { ok: false, reason: "payment_id_missing" };

  if (!demo) {
    try {
      if (input.via === "webhook") verifyWebhookSignature(input.rawBody ?? "", input.signature);
      else verifyCheckoutSignature({ orderId: input.orderId, paymentId, signature: input.signature });
    } catch (e) {
      const code = e instanceof PaymentError ? e.code : "signature_invalid";
      console.error("[payments] settle refused", input.via, code);
      return { ok: false, reason: code };
    }
  }

  return withRequestLock(existing.requestId, async (): Promise<SettleResult> => {
    // markPaymentPaid is idempotent per PAYMENT, but a job can carry several order records — re-charging or a
    // second checkout tab creates another. Without this, each one could credit the worker again for the same job.
    // Arbitrate per REQUEST, inside the lock, before anything is written.
    const siblings = await store.listPaymentsForRequest(existing.requestId);
    const alreadySettled = siblings.find((p) => p.status === "paid" && p.id !== existing.id);
    if (alreadySettled) {
      console.warn("[payments] refused a second settlement for job", existing.requestId, "already paid by", alreadySettled.id);
      const request = await store.getRequest(existing.requestId);
      const worker = await store.getHelper(alreadySettled.workerId);
      await store.updatePayment(existing.id, { status: "failed", error: "this job was already paid by another order" });
      return { ok: true, payment: alreadySettled, alreadyPaid: true, request, walletPaise: worker ? walletPaiseOf(worker) : null };
    }

    const marked = await store.markPaymentPaid(existing.id, paymentId);
    if (!marked.ok) return { ok: false, reason: "not_found" };
    const payment = marked.payment;
    if (marked.alreadyPaid) {
      // The other notification for the same payment. Report it, credit nothing.
      const request = await store.getRequest(payment.requestId);
      const worker = await store.getHelper(payment.workerId);
      return { ok: true, payment, alreadyPaid: true, request, walletPaise: worker ? walletPaiseOf(worker) : null };
    }

    const worker = await withHelperLock(payment.workerId, async () => {
      const h = await store.getHelper(payment.workerId);
      return h ? store.upsertHelper({ ...h, walletPaise: walletPaiseOf(h) + payment.payoutPaise }) : null;
    });
    if (!worker) console.error("[payments] settled a job whose worker is gone", payment.id, payment.workerId);
    const request = await store.updateRequest(payment.requestId, { paymentStatus: "paid" });
    if (worker) emit("helper:updated", { helper: worker });
    if (request) emit("request:updated", { request });
    await store.audit({
      at: nowIso(), user: payment.customerId ?? `order:${payment.orderId}`, action: "payment.settled",
      detail: `job ${payment.requestId} · gross ${formatPaise(payment.grossPaise)} = work ${formatPaise(payment.servicePaise)} + parts ${formatPaise(payment.reimbursementPaise)} · commission ${formatPaise(payment.commissionPaise)} (${payment.commissionPct}%) · payout ${formatPaise(payment.payoutPaise)} to ${payment.workerId} · ${payment.provider} ${payment.orderId}/${paymentId} via ${input.via}`,
    });
    return { ok: true, payment, alreadyPaid: false, request, walletPaise: worker ? walletPaiseOf(worker) : null };
  });
}
