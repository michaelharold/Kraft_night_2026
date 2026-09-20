/**
 * Paying for a finished job. The arithmetic is already covered by tests/money.test.ts and the records by
 * tests/store-payments.test.ts, so what is exercised here is the orchestration between them: who is allowed to name
 * a price, who is allowed to pay it, what the bill contains, and what happens when the gateway says "paid" twice.
 *
 * Two things make this worth testing rather than reading. First, Razorpay confirms a payment TWICE — the browser
 * callback and the server webhook, in either order — so "credit the worker" has to be attached to whichever of them
 * wins the race and to neither of the others; a wallet that gains the payout twice is the bug these tests exist to
 * catch. Second, the module has a demo mode for a laptop with no merchant account, and a demo mode that could be
 * reached while real keys are configured would be a way to pay for a job without paying, so that door is pushed on
 * from the outside here rather than assumed shut.
 *
 * No network: the gateway is stubbed by swapping globalThis.fetch, and the demo-mode tests never call it at all.
 */
process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → no model is ever waited on
process.env.RESQ_COMMISSION_PCT = "10";
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { MAX_REIMBURSEMENT_PAISE } from "../lib/money";
import { billFor, openOrder, setServiceCharge, settle } from "../lib/payments";
import { claim, createServiceRequest, resolve } from "../lib/waves";
import type { Helper, Payment, Reimbursement, Skill } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
const person = (id: string, km: number, skills: Skill[], phone: string): Helper => ({
  id, name: id, phone, skills, location: at(km), onDuty: true, reliability: 0.9, lastSeen: new Date().toISOString(),
});
const KEY_ID = "rzp_test_Sahaya1234567890";
const KEY_SECRET = "secret_do_not_ship_0001";
const WEBHOOK_SECRET = "webhook_secret_0002";

/** asha books a plumber, shaji takes it and finishes it; nisha is a second plumber who never touched the job. */
async function job(): Promise<string> {
  resetStoreForTests(new MemoryStore({ seed: false }));
  const s = getStore();
  const run = Math.floor(Math.random() * 9000 + 1000);
  await s.upsertHelper(person("asha", 0, [], `+9194${run}00001`));
  await s.upsertHelper(person("shaji", 0.4, ["plumber"], `+9194${run}00002`));
  await s.upsertHelper(person("nisha", 0.6, ["plumber"], `+9194${run}00003`));
  const asha = (await s.getHelper("asha"))!;
  const r = await createServiceRequest({ service: "plumber", description: "Burst pipe under the kitchen sink", location: C, account: asha, notify: false });
  assert.equal((await claim(r.id, "shaji")).ok, true);
  assert.equal((await resolve(r.id)).ok, true);
  return r.id;
}

let receiptSeq = 0;
async function receipt(requestId: string, status: Reimbursement["status"], claimedPaise: number, merchant = "Kollam Hardware"): Promise<Reimbursement> {
  receiptSeq += 1;
  return getStore().createReimbursement({
    id: `rb-${receiptSeq}`, requestId, workerId: "shaji", fileId: `grid-${receiptSeq}`, mime: "image/jpeg", size: 120_000,
    analysis: { looksLikeReceipt: true, merchant, purchasedAt: null, items: [], totalPaise: claimedPaise, confidence: 0.8, model: "llava:7b", source: "ollama", note: null },
    claimedPaise, note: null, status, createdAt: `2026-09-20T10:${String(receiptSeq).padStart(2, "0")}:00.000Z`,
    decidedAt: status === "pending" ? null : "2026-09-20T11:00:00.000Z", decidedBy: status === "pending" ? null : "asha",
  });
}

/** A live gateway that never touches the network: answers every order request with `orderId` for the asked amount. */
function stubGateway(orderId = `order_Live${randomUUID().slice(0, 8)}`) {
  const real = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify({ id: orderId, amount: body.amount, currency: "INR", status: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { orderId, calls, restore: () => { globalThis.fetch = real; } };
}
function liveKeys(): void {
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
}
function noKeys(): void {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
}
const checkoutSig = (orderId: string, paymentId: string) => createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
const webhookBody = (orderId: string, paymentId: string) => JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId } } } });
const webhookSig = (raw: string) => createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex");
// Service earnings live in walletPaise (PAISE). walletBalance is the separate rupee-denominated escrow wallet.
const wallet = async (id: string) => (await getStore().getHelper(id))!.walletPaise ?? 0;
const mustBill = async (requestId: string) => {
  const b = await billFor(requestId);
  if (!b.ok) assert.fail(`expected a bill, got ${b.reason}`);
  return b.bill;
};

test("the bill is the work plus the receipts the customer approved — and nothing else", async () => {
  const id = await job();
  const empty = await mustBill(id);
  assert.equal(empty.settlement, null, "there is no bill before the worker names a charge");
  assert.equal(empty.servicePaise, null);

  assert.equal((await setServiceCharge(id, "shaji", 1_000_00)).ok, true);
  const alone = await mustBill(id);
  assert.deepEqual(alone.items, []);
  assert.equal(alone.reimbursementPaise, 0);
  assert.equal(alone.settlement!.grossPaise, 1_000_00);
  assert.equal(alone.settlement!.commissionPaise, 100_00);
  assert.equal(alone.settlement!.payoutPaise, 900_00);

  await receipt(id, "approved", 450_00);
  const one = await mustBill(id);
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].label, "Parts from Kollam Hardware");
  assert.equal(one.reimbursementPaise, 450_00);
  assert.equal(one.settlement!.grossPaise, 1_450_00);
  assert.equal(one.settlement!.commissionPaise, 100_00, "buying parts must not grow the platform's cut");
  assert.equal(one.settlement!.payoutPaise, 1_350_00);

  await receipt(id, "approved", 120_00);
  await receipt(id, "approved", 30_50);
  await receipt(id, "pending", 5_000_00);   // the customer has not looked at this one yet
  await receipt(id, "rejected", 9_000_00);  // …and refused this one outright
  const three = await mustBill(id);
  assert.equal(three.items.length, 3, "only approved receipts are billed");
  assert.deepEqual(three.items.map((i) => i.amountPaise), [450_00, 120_00, 30_50]);
  assert.equal(three.reimbursementPaise, 600_50);
  assert.equal(three.settlement!.grossPaise, 1_600_50);
  assert.equal(three.settlement!.commissionPaise, 100_00);
  assert.equal(three.settlement!.payoutPaise, 1_500_50);
  assert.equal(three.items.reduce((n, i) => n + i.amountPaise, 0), three.settlement!.reimbursementPaise, "what the customer reads must add up to what they are charged");
  assert.equal(three.settlement!.payoutPaise + three.settlement!.commissionPaise, three.settlement!.grossPaise);
});

test("an approved receipt for an absurd amount is clamped on the bill, not billed", async () => {
  const id = await job();
  await setServiceCharge(id, "shaji", 500_00);
  await receipt(id, "approved", MAX_REIMBURSEMENT_PAISE + 1_00);
  const bill = await mustBill(id);
  assert.equal(bill.items[0].amountPaise, MAX_REIMBURSEMENT_PAISE);
  assert.equal(bill.settlement!.grossPaise, 500_00 + MAX_REIMBURSEMENT_PAISE);
});

test("only the worker on the job may name the charge, and only until it is paid", async () => {
  const id = await job();
  assert.equal((await setServiceCharge(id, "nisha", 900_00)).ok, false, "another plumber cannot bill this job");
  const other = await setServiceCharge(id, "nisha", 900_00);
  assert.equal(other.ok === false ? other.reason : null, "forbidden");
  const customer = await setServiceCharge(id, "asha", 1_00);
  assert.equal(customer.ok === false ? customer.reason : null, "forbidden", "the customer does not get to set the price either");
  assert.equal((await mustBill(id)).servicePaise, null, "a refused charge leaves no trace on the bill");

  const bad = await setServiceCharge(id, "shaji", 0);
  assert.equal(bad.ok === false ? bad.reason : null, "amount_invalid");
  assert.equal((await setServiceCharge(id, "shaji", 800_00)).ok, true);
  assert.equal((await setServiceCharge(id, "shaji", 850_00)).ok, true, "a worker may correct the amount while it is unpaid");
  assert.equal((await mustBill(id)).servicePaise, 850_00);
});

test("only the customer may open the order", async () => {
  const id = await job();
  await setServiceCharge(id, "shaji", 700_00);
  for (const who of ["shaji", "nisha", "someone-else"]) {
    const res = await openOrder(id, who);
    assert.equal(res.ok, false, `${who} must not be able to open an order`);
    assert.equal(res.ok === false ? res.reason : null, "forbidden");
  }
  assert.equal((await openOrder(id, "asha")).ok, true);
  assert.equal(await wallet("shaji"), 0, "opening an order moves no money on its own");
});

test("demo mode, end to end, with no keys configured at all", async () => {
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 1_200_00);
  await receipt(id, "approved", 300_00);

  const order = await openOrder(id, "asha");
  if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);
  assert.equal(order.provider, "demo");
  assert.equal(order.keyId, null, "there is no key to hand the browser");
  assert.ok(order.orderId.startsWith("order_demo_"), order.orderId);
  assert.equal(order.amountPaise, 1_500_00);
  assert.equal((await getStore().getRequest(id))!.paymentStatus, "processing");

  // The demo browser has no signature and no payment id; settlement still has to work or the demo is useless.
  const done = await settle({ orderId: order.orderId, via: "checkout" });
  if (!done.ok) assert.fail(`expected a settlement, got ${done.reason}`);
  assert.equal(done.alreadyPaid, false);
  assert.equal(done.payment.payoutPaise, 1_380_00); // 1200 work + 300 parts − 120 commission
  assert.equal(await wallet("shaji"), 1_380_00);
  assert.equal((await getStore().getRequest(id))!.paymentStatus, "paid");
  const bill = await mustBill(id);
  assert.equal(bill.paid, true);
  assert.ok(bill.paidAt);
  assert.ok((await getStore().listAudit()).some((e) => e.action === "payment.settled" && e.detail.includes("shaji")), "the split is written to the audit log");
  const reopened = await openOrder(id, "asha");
  assert.equal(reopened.ok === false ? reopened.reason : null, "already_paid");
});

test("the browser callback and the webhook settle the same payment once between them", async () => {
  liveKeys();
  const gw = stubGateway();
  try {
    const id = await job();
    await setServiceCharge(id, "shaji", 2_000_00);
    const order = await openOrder(id, "asha");
    if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);
    assert.equal(order.provider, "razorpay");
    assert.equal(order.keyId, KEY_ID);
    assert.equal(order.orderId, gw.orderId);
    assert.equal(gw.calls[0].amount, 2_000_00);
    assert.equal(gw.calls[0].currency, "INR");

    const payId = "pay_LiveTest0001";
    const viaBrowser = await settle({ orderId: order.orderId, paymentId: payId, signature: checkoutSig(order.orderId, payId), via: "checkout" });
    if (!viaBrowser.ok) assert.fail(`checkout settle failed: ${viaBrowser.reason}`);
    assert.equal(viaBrowser.alreadyPaid, false);
    assert.equal(await wallet("shaji"), 1_800_00);

    const raw = webhookBody(order.orderId, payId);
    const viaWebhook = await settle({ orderId: order.orderId, paymentId: payId, signature: webhookSig(raw), rawBody: raw, via: "webhook" });
    if (!viaWebhook.ok) assert.fail(`webhook settle failed: ${viaWebhook.reason}`);
    assert.equal(viaWebhook.alreadyPaid, true, "the second notification must not be treated as a second payment");
    assert.equal(await wallet("shaji"), 1_800_00, "the worker is paid once for one job");

    // Retries of both, all at once, for good measure.
    const storm = await Promise.all([
      settle({ orderId: order.orderId, paymentId: payId, signature: checkoutSig(order.orderId, payId), via: "checkout" }),
      settle({ orderId: order.orderId, paymentId: payId, signature: webhookSig(raw), rawBody: raw, via: "webhook" }),
      settle({ orderId: order.orderId, paymentId: payId, signature: checkoutSig(order.orderId, payId), via: "checkout" }),
    ]);
    assert.ok(storm.every((r) => r.ok && r.alreadyPaid));
    assert.equal(await wallet("shaji"), 1_800_00);
    assert.equal((await getStore().listPaymentsForRequest(id)).filter((p: Payment) => p.status === "paid").length, 1);
  } finally {
    gw.restore();
    noKeys();
  }
});

test("a signature that does not match is refused, and no money moves", async () => {
  liveKeys();
  const gw = stubGateway();
  try {
    const id = await job();
    await setServiceCharge(id, "shaji", 1_000_00);
    const order = await openOrder(id, "asha");
    if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);
    const payId = "pay_LiveTest0002";

    for (const signature of [undefined, "", "not-a-signature", checkoutSig(order.orderId, "pay_SomeOtherPayment"), checkoutSig("order_Someone_Else", payId), `${checkoutSig(order.orderId, payId)}0`]) {
      const res = await settle({ orderId: order.orderId, paymentId: payId, signature, via: "checkout" });
      assert.equal(res.ok, false, `signature ${String(signature)} must be refused`);
      assert.equal(res.ok === false ? res.reason : null, "signature_invalid");
    }
    const raw = webhookBody(order.orderId, payId);
    const tampered = await settle({ orderId: order.orderId, paymentId: payId, signature: webhookSig(`${raw} `), rawBody: raw, via: "webhook" });
    assert.equal(tampered.ok === false ? tampered.reason : null, "signature_invalid", "the webhook digest is over the exact bytes that arrived");

    assert.equal(await wallet("shaji"), 0);
    assert.equal((await getStore().getRequest(id))!.paymentStatus, "processing", "a refused signature leaves the job unpaid");
    assert.equal((await mustBill(id)).paid, false);

    // The real thing still works afterwards.
    const ok = await settle({ orderId: order.orderId, paymentId: payId, signature: checkoutSig(order.orderId, payId), via: "checkout" });
    assert.equal(ok.ok, true);
    assert.equal(await wallet("shaji"), 900_00);
  } finally {
    gw.restore();
    noKeys();
  }
});

test("an unknown order settles nothing, and demo mode is unreachable once real keys exist", async () => {
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 600_00);
  const order = await openOrder(id, "asha");
  if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);

  const unknown = await settle({ orderId: "order_never_opened_here", via: "checkout" });
  assert.equal(unknown.ok === false ? unknown.reason : null, "not_found");

  // Keys arrive between opening the order and paying it: the demo shortcut must close behind them.
  liveKeys();
  try {
    const noSig = await settle({ orderId: order.orderId, via: "checkout" });
    assert.equal(noSig.ok === false ? noSig.reason : null, "payment_id_missing");
    const forged = await settle({ orderId: order.orderId, paymentId: "pay_Forged", signature: "whatever", via: "checkout" });
    assert.equal(forged.ok === false ? forged.reason : null, "signature_invalid", "a demo order must not settle without a signature once keys exist");
    assert.equal(await wallet("shaji"), 0);
  } finally {
    noKeys();
  }
});

test("a job cannot be paid before it has a price, and the amount cannot change under an open order", async () => {
  noKeys();
  const id = await job();
  const early = await openOrder(id, "asha");
  assert.equal(early.ok === false ? early.reason : null, "amount_not_set");

  await setServiceCharge(id, "shaji", 500_00);
  const first = await openOrder(id, "asha");
  if (!first.ok) assert.fail(`expected an order, got ${first.reason}`);
  const again = await openOrder(id, "asha");
  assert.equal(again.ok && again.reused, true, "a customer who reloads gets the order they already have");
  assert.equal(again.ok ? again.orderId : null, first.orderId);

  assert.equal((await setServiceCharge(id, "shaji", 700_00)).ok, true);
  const stale = await settle({ orderId: first.orderId, via: "checkout" });
  assert.equal(stale.ok, true, "the gateway may still confirm the order the customer actually paid");
  // …but the superseded order is no longer offered: a new order is opened for the new amount.
  const third = await openOrder(id, "asha");
  assert.equal(third.ok === false ? third.reason : null, "already_paid");
});

// ── Regressions for the defects the adversarial review confirmed ─────────────────────────────────────────────

test("a job pays the worker once even when it accumulated several order records", async () => {
  // The CRITICAL one: markPaymentPaid is idempotent per PAYMENT, but re-charging a job creates a second order
  // record. Without a per-REQUEST guard inside the lock, settling both credited the worker twice for one job.
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 5_00_00);
  const first = await openOrder(id, "asha");
  if (!first.ok) assert.fail(`expected an order, got ${first.reason}`);

  await setServiceCharge(id, "shaji", 7_00_00);           // re-charge: order A is invalidated
  const second = await openOrder(id, "asha");
  if (!second.ok) assert.fail(`expected a second order, got ${second.reason}`);
  assert.notEqual(second.orderId, first.orderId, "a re-charge must open a different order");

  const paidB = await settle({ orderId: second.orderId, via: "checkout" });
  if (!paidB.ok) assert.fail(`expected B to settle, got ${paidB.reason}`);
  assert.equal(paidB.alreadyPaid, false);
  const afterB = await wallet("shaji");
  assert.equal(afterB, 6_30_00, "₹700 less 10% commission");

  // The stale order A must never pay out again, however it is replayed.
  const replayA = await settle({ orderId: first.orderId, via: "checkout" });
  assert.equal(replayA.ok && replayA.alreadyPaid, true, "a second order on a paid job settles nothing");
  assert.equal(await wallet("shaji"), afterB, "the worker is paid once for one job");
});

test("re-entering the amount kills the open order, so nothing stays payable at the old total", async () => {
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 5_00_00);
  const open = await openOrder(id, "asha");
  if (!open.ok) assert.fail(`expected an order, got ${open.reason}`);
  assert.equal((await getStore().getRequest(id))!.paymentStatus, "processing");

  // Same figure re-entered: previously this left the order open while flipping the bill back to "due", so an
  // approved receipt could be added to a total the customer was already paying.
  await setServiceCharge(id, "shaji", 5_00_00);
  const payments = await getStore().listPaymentsForRequest(id);
  assert.equal(payments.filter((p) => p.status === "created").length, 0, "no order may survive a re-charge");
  assert.equal((await getStore().getRequest(id))!.paymentStatus, "due");
});

test("an unauthenticated webhook cannot move money just because no keys are configured", async () => {
  // Demo mode skips signature checks. The browser callback can afford that (the session had to be the customer
  // to open the order); the webhook cannot — it has no caller identity, and the order id leaks to the worker
  // through /api/payments/bill. So a demo webhook must be refused rather than waved through.
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 4_00_00);
  const order = await openOrder(id, "asha");
  if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);

  const raw = webhookBody(order.orderId, "pay_forged_0001");
  const forged = await settle({ orderId: order.orderId, paymentId: "pay_forged_0001", signature: "not-a-signature", rawBody: raw, via: "webhook" });
  assert.equal(forged.ok, false, "a demo webhook must still be verified");
  assert.equal(await wallet("shaji"), 0, "no money moved");
  assert.notEqual((await getStore().getRequest(id))!.paymentStatus, "paid");
});

test("service earnings and the escrow wallet are kept in different fields, because they are different units", async () => {
  noKeys();
  const id = await job();
  await setServiceCharge(id, "shaji", 1_000_00);
  const order = await openOrder(id, "asha");
  if (!order.ok) assert.fail(`expected an order, got ${order.reason}`);
  const done = await settle({ orderId: order.orderId, via: "checkout" });
  assert.equal(done.ok, true);

  const shaji = (await getStore().getHelper("shaji"))!;
  assert.equal(shaji.walletPaise, 9_00_00, "₹900 of earnings, in paise");
  assert.equal(shaji.walletBalance ?? 0, 0, "the rupee-denominated escrow wallet is untouched");
});
