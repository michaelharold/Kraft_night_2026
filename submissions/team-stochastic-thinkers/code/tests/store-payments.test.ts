/**
 * The store's money records. Three promises the payment routes are built on are checked here: what goes in comes
 * back out unchanged, a caller holding a record the store handed it cannot reach into stored state through it, and
 * a payment settles exactly once no matter how often the gateway tells us about it.
 *
 * That last one is not hypothetical. Razorpay sends BOTH a browser callback and a server webhook for the same
 * payment, so markPaymentPaid is called twice for every real payment; if both calls came back alreadyPaid: false
 * the worker would be credited twice for one job, which is why the race is exercised here rather than assumed.
 */
process.env.SEED_ON_BOOT = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store/memory";
import { computeSettlement } from "../lib/money";
import type { MarkPaidResult } from "../lib/store";
import type { Payment, Reimbursement } from "../lib/types";

const newStore = () => new MemoryStore({ seed: false, persistence: null });
const split = computeSettlement({ servicePaise: 1_000_00, reimbursementPaise: 450_00, pct: 10 });

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: "pay-1", requestId: "req-1", customerId: "cust-1", workerId: "worker-1", provider: "razorpay",
  orderId: "order_NfX1", paymentId: null, ...split, status: "created", error: null,
  createdAt: "2026-09-20T09:00:00.000Z", paidAt: null, ...over,
});

const reimbursement = (over: Partial<Reimbursement> = {}): Reimbursement => ({
  id: "rb-1", requestId: "req-1", workerId: "worker-1", fileId: "grid-abc", mime: "image/jpeg", size: 240_000,
  analysis: { looksLikeReceipt: true, merchant: "Kollam Hardware", purchasedAt: "20/09/2026",
    items: [{ name: "1/2 inch brass tap", qty: 1, amountPaise: 400_00 }, { name: "teflon tape", qty: 2, amountPaise: 25_00 }],
    totalPaise: 450_00, confidence: 0.82, model: "llava:7b", source: "ollama", note: null },
  claimedPaise: 450_00, note: "new tap + teflon tape", status: "pending",
  createdAt: "2026-09-20T09:05:00.000Z", decidedAt: null, decidedBy: null, ...over,
});

/** assert.ok does not narrow a discriminated union, so failures route through assert.fail (which returns never). */
function mustBeOk(r: MarkPaidResult): Extract<MarkPaidResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected a payment, got ${r.reason}`);
  return r;
}

test("a payment goes in and comes back exactly as it was written", async () => {
  const store = newStore();
  const p = payment();
  assert.deepEqual(await store.createPayment(p), p);
  assert.deepEqual(await store.getPayment("pay-1"), p);
  assert.equal(await store.getPayment("pay-nope"), null);
  // The split is carried verbatim: the store must not recompute or round anything.
  const stored = (await store.getPayment("pay-1"))!;
  assert.equal(stored.grossPaise, 1_450_00);
  assert.equal(stored.commissionPaise, 100_00);
  assert.equal(stored.payoutPaise + stored.commissionPaise, stored.grossPaise);
});

test("a reimbursement round-trips, receipt analysis and all", async () => {
  const store = newStore();
  const r = reimbursement();
  assert.deepEqual(await store.createReimbursement(r), r);
  const back = (await store.getReimbursement("rb-1"))!;
  assert.deepEqual(back, r);
  assert.equal(back.analysis!.items.length, 2);
  assert.equal(await store.getReimbursement("rb-nope"), null);

  const decided = await store.updateReimbursement("rb-1", { status: "approved", decidedAt: "2026-09-20T09:09:00.000Z", decidedBy: "cust-1" });
  assert.equal(decided!.status, "approved");
  assert.equal(decided!.claimedPaise, 450_00, "approving must not disturb the amount");
  assert.equal(await store.updateReimbursement("rb-nope", { status: "approved" }), null);
});

test("records are listed per job, oldest first, and never leak into another job's list", async () => {
  const store = newStore();
  await store.createPayment(payment({ id: "pay-b", orderId: "order_b", createdAt: "2026-09-20T11:00:00.000Z" }));
  await store.createPayment(payment({ id: "pay-a", orderId: "order_a", createdAt: "2026-09-20T10:00:00.000Z" }));
  await store.createPayment(payment({ id: "pay-other", requestId: "req-2", orderId: "order_c" }));
  assert.deepEqual((await store.listPaymentsForRequest("req-1")).map((p) => p.id), ["pay-a", "pay-b"]);
  assert.deepEqual((await store.listPaymentsForRequest("req-2")).map((p) => p.id), ["pay-other"]);
  assert.deepEqual(await store.listPaymentsForRequest("req-unknown"), []);

  await store.createReimbursement(reimbursement({ id: "rb-b", createdAt: "2026-09-20T12:00:00.000Z" }));
  await store.createReimbursement(reimbursement({ id: "rb-a", createdAt: "2026-09-20T11:30:00.000Z" }));
  await store.createReimbursement(reimbursement({ id: "rb-other", requestId: "req-2" }));
  assert.deepEqual((await store.listReimbursements("req-1")).map((r) => r.id), ["rb-a", "rb-b"]);
  assert.deepEqual((await store.listReimbursements("req-2")).map((r) => r.id), ["rb-other"]);
});

test("getPaymentByOrderId finds the payment a webhook is talking about", async () => {
  const store = newStore();
  await store.createPayment(payment({ id: "pay-1", orderId: "order_NfX1" }));
  await store.createPayment(payment({ id: "pay-2", orderId: "order_NfX2" }));
  assert.equal((await store.getPaymentByOrderId("order_NfX2"))!.id, "pay-2");
  assert.equal(await store.getPaymentByOrderId("order_never_created"), null);
});

test("stored records cannot be mutated through the objects the store hands out", async () => {
  const store = newStore();
  const input = payment();
  const created = await store.createPayment(input);
  input.payoutPaise = 9_999_00;            // the caller keeps writing to its own object after handing it over
  created.status = "paid";
  created.grossPaise = 1;
  const stored = (await store.getPayment("pay-1"))!;
  assert.equal(stored.status, "created");
  assert.equal(stored.grossPaise, 1_450_00);
  assert.equal(stored.payoutPaise, split.payoutPaise);

  const listed = await store.listPaymentsForRequest("req-1");
  listed[0].commissionPaise = 0;
  assert.equal((await store.getPayment("pay-1"))!.commissionPaise, 100_00);

  const rb = await store.createReimbursement(reimbursement());
  rb.analysis!.totalPaise = 99_999_00;     // nested state must be cloned too, not just the top level
  rb.analysis!.items.push({ name: "invented line", qty: 1, amountPaise: 50_000_00 });
  const backRb = (await store.getReimbursement("rb-1"))!;
  assert.equal(backRb.analysis!.totalPaise, 450_00);
  assert.equal(backRb.analysis!.items.length, 2);
});

test("settlement is idempotent: however many notifications arrive, exactly one credits the worker", async () => {
  const store = newStore();
  await store.createPayment(payment());
  // The browser callback and the webhook, plus retries, all racing on the same payment.
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.markPaymentPaid("pay-1", `pay_razorpay_${i}`)));
  const winners = results.filter((r): r is Extract<MarkPaidResult, { ok: true }> => r.ok && !r.alreadyPaid);
  assert.equal(winners.length, 1, "exactly one caller may credit the worker");

  const credited = winners[0].payment;
  const stored = (await store.getPayment("pay-1"))!;
  assert.equal(stored.status, "paid");
  assert.equal(stored.paymentId, credited.paymentId);
  assert.ok(stored.paidAt, "a paid payment is stamped with when it was paid");
  // Every loser is handed the settled record, so the route can report the payment without crediting again.
  for (const r of results) {
    const ok = mustBeOk(r);
    assert.equal(ok.payment.paymentId, credited.paymentId);
    assert.equal(ok.payment.status, "paid");
  }
  // A notification arriving minutes later is still a no-op.
  const late = mustBeOk(await store.markPaymentPaid("pay-1", "pay_razorpay_late"));
  assert.equal(late.alreadyPaid, true);
  assert.equal((await store.getPayment("pay-1"))!.paymentId, credited.paymentId);
});

test("a failed attempt the gateway later confirms settles once; a refunded one never re-settles", async () => {
  const store = newStore();
  await store.createPayment(payment({ id: "pay-fail", orderId: "order_f" }));
  await store.updatePayment("pay-fail", { status: "failed", error: "payment declined by bank" });
  const confirmed = mustBeOk(await store.markPaymentPaid("pay-fail", "pay_late_ok"));
  assert.equal(confirmed.alreadyPaid, false, "money that actually moved must reach the worker");
  assert.equal(confirmed.payment.error, null, "a settled payment no longer carries the failed attempt's error");
  assert.equal(mustBeOk(await store.markPaymentPaid("pay-fail", "pay_again")).alreadyPaid, true);

  await store.createPayment(payment({ id: "pay-refunded", orderId: "order_r" }));
  await store.updatePayment("pay-refunded", { status: "refunded", paymentId: "pay_reversed" });
  const refunded = mustBeOk(await store.markPaymentPaid("pay-refunded", "pay_zombie"));
  assert.equal(refunded.alreadyPaid, true, "a reversal must not be turned back into a payout");
  assert.equal((await store.getPayment("pay-refunded"))!.status, "refunded");
});

test("patches keep a payment attached to its own job, and unknown ids answer plainly", async () => {
  const store = newStore();
  await store.createPayment(payment());
  const patched = await store.updatePayment("pay-1", { id: "pay-hijack", requestId: "req-someone-else", error: "otp not entered" } as Partial<Payment>);
  assert.equal(patched!.id, "pay-1");
  assert.equal(patched!.requestId, "req-1");
  assert.equal(patched!.error, "otp not entered");
  assert.equal(await store.getPayment("pay-hijack"), null);

  assert.equal(await store.updatePayment("pay-nope", { error: "x" }), null);
  const missing = await store.markPaymentPaid("pay-nope", "pay_1");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false ? missing.reason : null, "not_found");
});
