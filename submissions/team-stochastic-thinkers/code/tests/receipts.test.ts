/**
 * A vision model reading a crumpled thermal print is the least trustworthy input in this codebase, and it is
 * pointed straight at somebody's bill. So these tests are mostly about refusal: what the reader is NOT allowed to
 * turn into money. A negative total, a total ten times the per-receipt cap, a photo that is not a receipt at all,
 * line items that do not add up to the printed total — none of them may quietly become an amount a customer owes.
 *
 * The rest is the human half of the same rule: the accepted worker is the only person who can file a claim, the
 * customer is the only person who can approve one, and a rejected claim never reaches any total. The Ollama call
 * and the GridFS write are stubbed throughout, so the whole path runs with no model installed and no MongoDB —
 * which is also the real fallback: the worker types the figure and the photo is the evidence.
 */
process.env.SEED_ON_BOOT = "0";
process.env.RESQ_RECEIPT_MODEL = "";            // exercise the default chain, not whatever this machine has
process.env.OLLAMA_URL = "http://127.0.0.1:9";  // nothing listens there; every call below is stubbed anyway

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MAX_REIMBURSEMENTS_PER_JOB, MAX_REIMBURSEMENT_PAISE } from "../lib/money";
import {
  ReceiptError, analyseReceipt, approvedReimbursementPaise, decideReceipt, listReceipts, normalizeReceipt, receiptModels, submitReceipt,
  type ReceiptDeps,
} from "../lib/receipts";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import type { HelpRequest, ReceiptAnalysis } from "../lib/types";

const BYTES = Buffer.from("pretend this is a photo of a receipt");
const MIME = "image/jpeg";

const reading = (over: Partial<ReceiptAnalysis> = {}): ReceiptAnalysis => ({
  looksLikeReceipt: true, merchant: "Kollam Hardware", purchasedAt: "20/09/2026",
  items: [{ name: "1/2 inch brass tap", qty: 1, amountPaise: 450_00 }],
  totalPaise: 450_00, confidence: 0.8, model: "test-vision", source: "ollama", note: null, ...over,
});

/** The vision model and GridFS, stubbed. `outcome` may be an Error to stand in for "no model installed". */
const deps = (outcome: ReceiptAnalysis | Error = reading()): ReceiptDeps => ({
  analyse: async () => { if (outcome instanceof Error) throw outcome; return outcome; },
  save: async () => `receipts:${randomUUID()}`,
});

/** A fresh store holding one accepted job: customer "cust-1", the worker who took it "worker-1". */
async function job(over: Partial<HelpRequest> = {}): Promise<HelpRequest> {
  resetStoreForTests(new MemoryStore({ seed: false, persistence: null }));
  const now = new Date().toISOString();
  return getStore().createRequest({
    id: "req-1", requesterId: "cust-1", requesterName: "Asha", requesterPhone: "+919000000001", requesterHelperId: "cust-1",
    description: "Bathroom pipe burst", location: null, locationSource: "none", landmark: null, channel: "app", role: "self",
    service: "plumber", triage: null, status: "matched", wave: 1, radiusKm: 2, waveStartedAt: null,
    matchedHelperId: "worker-1", createdAt: now, updatedAt: now, ...over,
  });
}

const file = (rupees?: string) => ({ requestId: "req-1", workerId: "worker-1", bytes: BYTES, mime: MIME, size: BYTES.length, rupees });

// ─── What the model returns is never taken at its word ────────────────────────────────────────────────────────

test("rupees become integer paise and unusable line items are dropped", () => {
  const a = normalizeReceipt({
    looksLikeReceipt: "true",                      // small models answer the string
    merchant: "  Kollam   Hardware  ", purchasedAt: "20/09/2026",
    items: [
      { name: "1/2 inch brass tap", qty: "1", amount: 400.5 },
      { name: "teflon tape", qty: 2, amount: "₹49.50" },
      { name: "", amount: 100 },                   // no name: not a line item
      { name: "unreadable smudge", amount: null }, // no amount: not a line item
      { name: "returned washer", amount: -20 },    // nothing on a receipt is negative
    ],
    total: 450, confidence: "0.9",
  }, "moondream");
  assert.equal(a.totalPaise, 450_00);
  assert.equal(a.merchant, "Kollam Hardware");
  assert.deepEqual(a.items.map((i) => [i.name, i.amountPaise]), [["1/2 inch brass tap", 400_50], ["teflon tape", 49_50]]);
  assert.equal(a.items[0].qty, 1);
  assert.equal(a.confidence, 0.9);
  assert.equal(a.model, "moondream");
  assert.equal(a.source, "ollama");
  assert.equal(a.note, null, "a clean reading needs no warning");
});

test("a total the reader cannot have read right is never offered as an amount", () => {
  const zero = normalizeReceipt({ looksLikeReceipt: true, items: [], total: 0, confidence: 1 }, "m");
  assert.equal(zero.totalPaise, null);
  assert.match(zero.note ?? "", /usable total/);

  const negative = normalizeReceipt({ looksLikeReceipt: true, items: [], total: -450, confidence: 1 }, "m");
  assert.equal(negative.totalPaise, null);

  // A misplaced decimal point is the likeliest reason for a huge figure, so it is dropped rather than shown.
  const huge = normalizeReceipt({ looksLikeReceipt: true, items: [], total: MAX_REIMBURSEMENT_PAISE, confidence: 1 }, "m");
  assert.equal(huge.totalPaise, null);
  assert.match(huge.note ?? "", /₹10,000/);

  const wordy = normalizeReceipt({ looksLikeReceipt: true, items: [], total: "about four fifty", confidence: 1 }, "m");
  assert.equal(wordy.totalPaise, null);

  const confidence = normalizeReceipt({ looksLikeReceipt: true, items: [], total: 450, confidence: 7 }, "m");
  assert.equal(confidence.confidence, 1, "confidence is clamped, not believed");
});

test("a photo the reader does not think is a receipt yields no amount at all", () => {
  const a = normalizeReceipt({ looksLikeReceipt: false, merchant: null, items: [{ name: "tap", amount: 450 }], total: 450, confidence: 0.9 }, "m");
  assert.equal(a.looksLikeReceipt, false);
  assert.equal(a.totalPaise, null, "no number is invented from a photo of somebody's cat");
  assert.match(a.note ?? "", /does not look like a shop receipt/);
});

test("lines that do not add up to the printed total leave the customer a warning", () => {
  const a = normalizeReceipt({
    looksLikeReceipt: true,
    items: [{ name: "tap", amount: 450 }, { name: "tape", amount: 50 }],
    total: 1500, confidence: 0.6,
  }, "m");
  assert.equal(a.totalPaise, 1500_00, "the printed total is kept: the lines may be the misread half");
  assert.match(a.note ?? "", /₹500/);
  assert.match(a.note ?? "", /₹1,500/);

  // Within 20 % is ordinary (rounding, an unlisted tax line), and gets no scary note.
  const close = normalizeReceipt({ looksLikeReceipt: true, items: [{ name: "tap", amount: 450 }], total: 500, confidence: 0.6 }, "m");
  assert.equal(close.note, null);
});

test("a reply that is not an object at all is rejected outright", () => {
  assert.throws(() => normalizeReceipt("sorry, I cannot read this", "m"), ReceiptError);
  assert.throws(() => normalizeReceipt([{ total: 450 }], "m"), ReceiptError);
  assert.throws(() => normalizeReceipt(null, "m"), ReceiptError);
});

test("the model chain steps past models that are not installed, and gives up cleanly when none are", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const tried: string[] = [];

  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { model: string; images: string[]; stream: boolean; options: { temperature: number } };
    tried.push(sent.model);
    assert.ok(!sent.images[0].startsWith("data:"), "Ollama takes raw base64, never a data: URI");
    assert.equal(sent.images[0], BYTES.toString("base64"));
    assert.equal(sent.stream, false);
    assert.equal(sent.options.temperature, 0);
    if (sent.model !== "qwen2.5vl:3b") return new Response("model 'x' not found", { status: 404 }); // not pulled
    return new Response(JSON.stringify({ response: JSON.stringify({ looksLikeReceipt: true, merchant: "Kollam Hardware", items: [{ name: "tap", amount: 450 }], total: 450, confidence: 0.7 }) }), { status: 200 });
  }) as unknown as typeof fetch;

  const a = await analyseReceipt(BYTES, MIME);
  assert.deepEqual(tried, ["llama3.2-vision:11b", "qwen2.5vl:3b"], "in order, stopping at the first that answers");
  assert.equal(a.model, "qwen2.5vl:3b");
  assert.equal(a.totalPaise, 450_00);

  globalThis.fetch = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => analyseReceipt(BYTES, MIME), (e: unknown) => e instanceof ReceiptError && e.code === "ai_unavailable");
  await assert.rejects(() => analyseReceipt(BYTES, "application/pdf"), (e: unknown) => e instanceof ReceiptError && e.code === "ai_invalid");
});

// ─── Who may file a claim, and who may turn it into money ─────────────────────────────────────────────────────

test("only the worker who accepted the job may file a receipt against it", async () => {
  await job();
  for (const stranger of ["worker-2", "cust-1", "ops"]) {
    const r = await submitReceipt({ ...file("450"), workerId: stranger }, deps());
    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.reason : null, "not_worker", `${stranger} must not be able to bill this customer`);
  }
  assert.deepEqual(await getStore().listReimbursements("req-1"), [], "a refused upload leaves nothing behind");

  const ok = await submitReceipt(file("450"), deps());
  assert.equal(ok.ok, true);

  await job({ status: "cancelled" });
  const cancelled = await submitReceipt(file("450"), deps());
  assert.equal(cancelled.ok === false ? cancelled.reason : null, "job_not_active");
});

test("a job takes at most MAX_REIMBURSEMENTS_PER_JOB live claims; a rejected one hands its slot back", async () => {
  await job();
  for (let i = 0; i < MAX_REIMBURSEMENTS_PER_JOB; i++) {
    const r = await submitReceipt(file("450"), deps());
    assert.equal(r.ok, true, `claim ${i + 1} should be accepted`);
  }
  const over = await submitReceipt(file("450"), deps());
  assert.equal(over.ok === false ? over.reason : null, "too_many");
  assert.equal((await getStore().listReimbursements("req-1")).length, MAX_REIMBURSEMENTS_PER_JOB);

  const first = (await getStore().listReimbursements("req-1"))[0];
  assert.equal((await decideReceipt({ requestId: "req-1", receiptId: first.id, customerId: "cust-1", action: "reject" })).ok, true);
  const again = await submitReceipt(file("450"), deps());
  assert.equal(again.ok, true, "a rejected claim can never reach the bill, so it must not cost the worker a slot");
});

test("with no vision model the worker types the figure; with no figure the claim is refused, not guessed", async () => {
  await job();
  const noModel = deps(new ReceiptError("ai_unavailable", "no vision model installed"));

  const blank = await submitReceipt(file(), noModel);
  assert.equal(blank.ok === false ? blank.reason : null, "amount_required");
  assert.equal(blank.ok === false ? blank.analysis?.source : null, "manual", "the refusal carries the reading, so the app can say why");
  assert.deepEqual(await getStore().listReimbursements("req-1"), [], "nothing is stored, and no image is kept");

  const typed = await submitReceipt(file("450.50"), noModel);
  assert.equal(typed.ok, true);
  if (!typed.ok) return;
  assert.equal(typed.reimbursement.claimedPaise, 450_50);
  assert.equal(typed.reimbursement.status, "pending", "filing a claim changes nothing the customer owes");
  assert.equal(typed.reimbursement.analysis?.source, "manual");
  assert.equal(typed.reimbursement.analysis?.totalPaise, null, "a manual claim must not pretend a model read it");
});

test("the worker may correct the reader's figure, and the reader's own figure stays on the record", async () => {
  await job();
  const r = await submitReceipt(file("480"), deps(reading({ totalPaise: 450_00 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.reimbursement.claimedPaise, 480_00, "the worker's figure is what is claimed");
  assert.equal(r.reimbursement.analysis?.totalPaise, 450_00, "the AI's reading is still there for the customer to compare");

  for (const bad of ["0", "-40", "twelve hundred", String(MAX_REIMBURSEMENT_PAISE / 100 + 1)]) {
    const refused = await submitReceipt(file(bad), deps());
    assert.equal(refused.ok === false ? refused.reason : null, "amount_invalid", `"${bad}" must not become a claim`);
  }
});

test("only the customer decides, approving is what adds to the bill, and rejecting adds nothing", async () => {
  await job();
  const tap = await submitReceipt(file("450"), deps());
  const tape = await submitReceipt(file("120"), deps());
  assert.ok(tap.ok && tape.ok);
  if (!tap.ok || !tape.ok) return;
  assert.equal(await approvedReimbursementPaise("req-1"), 0, "a pending claim is not money yet");

  for (const notTheCustomer of ["worker-1", "worker-2"]) {
    const r = await decideReceipt({ requestId: "req-1", receiptId: tap.reimbursement.id, customerId: notTheCustomer, action: "approve" });
    assert.equal(r.ok === false ? r.reason : null, "not_customer", "the worker must not approve their own claim");
  }

  const approved = await decideReceipt({ requestId: "req-1", receiptId: tap.reimbursement.id, customerId: "cust-1", action: "approve" });
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.reimbursement.status, "approved");
  assert.equal(approved.reimbursement.decidedBy, "cust-1");
  assert.ok(approved.reimbursement.decidedAt);
  assert.equal(approved.reimbursement.claimedPaise, 450_00, "approving must not disturb the amount");
  assert.equal(approved.approvedPaise, 450_00);

  const rejected = await decideReceipt({ requestId: "req-1", receiptId: tape.reimbursement.id, customerId: "cust-1", action: "reject" });
  assert.equal(rejected.ok, true);
  assert.equal(await approvedReimbursementPaise("req-1"), 450_00, "a rejected receipt adds nothing to what is owed");

  // A double-tapped approve is the same approve; reversing a decision is refused so the total cannot wobble.
  assert.equal((await decideReceipt({ requestId: "req-1", receiptId: tap.reimbursement.id, customerId: "cust-1", action: "approve" })).ok, true);
  const reversal = await decideReceipt({ requestId: "req-1", receiptId: tap.reimbursement.id, customerId: "cust-1", action: "reject" });
  assert.equal(reversal.ok === false ? reversal.reason : null, "already_decided");
  assert.equal(await approvedReimbursementPaise("req-1"), 450_00);

  const view = await listReceipts("req-1", "cust-1");
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.view.role, "customer");
  assert.equal(view.view.approvedPaise, 450_00);
  assert.equal(view.view.pendingPaise, 0);
  assert.equal((await listReceipts("req-1", "worker-1")).ok, true, "the worker sees their own claims");
  const outsider = await listReceipts("req-1", "worker-9");
  assert.equal(outsider.ok === false ? outsider.reason : null, "forbidden");
});

test("once the job is paid the bill is closed to both sides", async () => {
  await job();
  const filed = await submitReceipt(file("450"), deps());
  assert.ok(filed.ok);
  if (!filed.ok) return;
  await getStore().updateRequest("req-1", { paymentStatus: "paid" });

  const late = await submitReceipt(file("450"), deps());
  assert.equal(late.ok === false ? late.reason : null, "already_paid");
  const decided = await decideReceipt({ requestId: "req-1", receiptId: filed.reimbursement.id, customerId: "cust-1", action: "approve" });
  assert.equal(decided.ok === false ? decided.reason : null, "already_paid");

  // Mid-checkout is closed too: the amount must not change under the customer while the gateway holds an order.
  await getStore().updateRequest("req-1", { paymentStatus: "processing" });
  const midway = await submitReceipt(file("450"), deps());
  assert.equal(midway.ok === false ? midway.reason : null, "payment_in_progress");
});

test("moondream is not in the default chain, because it cannot read a bill", () => {
  // Measured, not assumed: against a clean test receipt (Rs 450 + 60 + 35 + 95 = Rs 640) moondream returned every
  // line priced "4.17" with no total, identically over three runs at temperature 0. A number this model produces
  // would become a charge on a customer's bill, so no reading at all is the better failure. See lib/receipts.ts.
  assert.ok(!receiptModels().includes("moondream"), "a model that misreads money must not be a silent fallback");
  assert.deepEqual(receiptModels(), ["llama3.2-vision:11b", "qwen2.5vl:3b"]);

  // ...but an operator can still choose it deliberately.
  const prev = process.env.RESQ_RECEIPT_MODEL;
  try {
    process.env.RESQ_RECEIPT_MODEL = "moondream";
    assert.equal(receiptModels()[0], "moondream", "an explicit override always wins");
  } finally {
    if (prev === undefined) delete process.env.RESQ_RECEIPT_MODEL; else process.env.RESQ_RECEIPT_MODEL = prev;
  }
});
