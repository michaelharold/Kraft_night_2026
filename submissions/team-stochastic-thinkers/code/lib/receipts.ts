/**
 * Receipts a worker paid for out of their own pocket, read by a local vision model and approved by the customer.
 *
 * A plumber who buys a ₹450 tap mid-job photographs the bill; the model reads it; the CUSTOMER taps approve before
 * a single paisa is added to what they owe. That order is the whole design. A 3-billion-parameter model reading a
 * crumpled thermal print in bad light will sometimes see 4500 where the paper says 450, so nothing in here is
 * allowed to move money on its own: the reading is evidence shown next to the photo, the worker may correct the
 * figure, and the customer decides. The model's original reading stays on the record (`analysis`) beside whatever
 * the worker claimed (`claimedPaise`), so a worker who edits 450 into 4500 is editing in front of the person paying.
 *
 * Everything the model returns is treated as hostile input. Amounts become integer paise or become null; line items
 * without both a name and an amount are dropped; a total over MAX_REIMBURSEMENT_PAISE is discarded rather than
 * billed; and when the lines do not add up to the printed total we keep the printed total but attach a `note`, so
 * the customer reads the discrepancy instead of the model quietly picking a side.
 *
 * The model chain degrades all the way to nothing: RESQ_RECEIPT_MODEL, then llama3.2-vision, qwen2.5vl, moondream,
 * and if none of them are installed analyseReceipt throws ai_unavailable — the worker then types the amount, the
 * photo is still the evidence, and the customer still approves. The AI makes this feature quick, not possible.
 *
 * Ordering note: the vision call happens OUTSIDE the request lock (a minute of GPU must not stall the job's ticks
 * and claims), and only the count-and-create is taken under withRequestLock, which is what stops a double-tapped
 * upload from slipping past MAX_REIMBURSEMENTS_PER_JOB.
 */
import { randomUUID } from "node:crypto";
import { emit } from "./events";
import { RECEIPT_TYPES, saveReceipt } from "./files";
import { MAX_REIMBURSEMENTS_PER_JOB, MAX_REIMBURSEMENT_PAISE, PAISE_PER_RUPEE, formatPaise, parseRupeesToPaise } from "./money";
import { getStore } from "./store";
import { withRequestLock } from "./waves";
import type { HelpRequest, ReceiptAnalysis, ReceiptItem, Reimbursement } from "./types";

export class ReceiptError extends Error {
  constructor(public code: "ai_unavailable" | "ai_invalid", message: string) { super(message); }
}

const MAX_ITEMS = 20;
const ollamaUrl = () => (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
/** Vision models are several times slower than the text models in lib/scope.ts, hence the minute. */
const timeoutMs = () => { const n = Number(process.env.RESQ_RECEIPT_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 60_000; };

/**
 * First model that answers wins.
 *
 * moondream was in this chain and has been REMOVED after measurement, not theory. Against a clean, high-contrast
 * test receipt (₹450 + ₹60 + ₹35 + ₹95 = ₹640) it returned, identically across three runs at temperature 0, every
 * single line priced at "4.17", a degenerate loop of repeated items, and no total at all. On a plainer schema it
 * read the ₹640 total as ₹441. It is a 1.7 GB model and it cannot read digits off a bill.
 *
 * That matters more than "a weak fallback is better than none", because this number becomes a charge on a
 * customer's bill. Having no reading at all is an honest outcome: the worker types the figure and the receipt
 * photo stands as the evidence the customer approves against. A confident ₹4.17 is not.
 *
 * RESQ_RECEIPT_MODEL still overrides everything, so anyone can put moondream (or anything else) back deliberately.
 */
export function receiptModels(): string[] {
  const chosen = process.env.RESQ_RECEIPT_MODEL?.trim();
  return [...new Set([chosen, "llama3.2-vision:11b", "qwen2.5vl:3b"].filter((m): m is string => !!m))];
}

export function receiptPrompt(): string {
  return [
    "This photo is a shop receipt a repair worker was given when buying parts for a job in Kerala, India.",
    "Read it and return ONLY one raw JSON object. No prose, no markdown, no code fences.",
    "Fields:",
    "- looksLikeReceipt: true only if this image really is a shop bill, receipt or invoice.",
    "- merchant: the shop's name as printed, or null.",
    "- purchasedAt: the date exactly as printed on the paper, or null.",
    "- items: the purchased lines, each { name, qty, amount } where amount is that line's price in RUPEES as a number.",
    "- total: the grand total in RUPEES as a number, e.g. 1250.50. Copy the printed total; do not add the lines up yourself.",
    "- confidence: 0 to 1, how sure you are that you read the total correctly.",
    "Every amount is Indian rupees. Never invent a figure you cannot actually see on the paper — write null instead.",
  ].join("\n");
}

export function receiptSchema(): Record<string, unknown> {
  const nullableStr = { type: ["string", "null"] };
  const nullableNum = { type: ["number", "null"] };
  return {
    type: "object",
    properties: {
      looksLikeReceipt: { type: "boolean" },
      merchant: nullableStr,
      purchasedAt: nullableStr,
      items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, qty: nullableNum, amount: nullableNum }, required: ["name", "amount"] } },
      total: nullableNum,
      confidence: { type: "number" },
    },
    required: ["looksLikeReceipt", "items", "total", "confidence"],
  };
}

const clean = (x: unknown, max: number): string | null => {
  if (typeof x !== "string") return null;
  return x.replace(/\s+/g, " ").trim().slice(0, max) || null;
};
/** Rupees off a receipt → integer paise. Takes the model's number or its "₹1,250.50" string; null when unreadable. */
const toPaise = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? Math.round(x * PAISE_PER_RUPEE) : null;
  return parseRupeesToPaise(x);
};
const qtyOf = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n)) : null;
};
// Small models answer "true", "yes" and true for the same question; anything else counts as no.
const truthy = (x: unknown) => x === true || x === "true" || x === "yes";

/**
 * Hand-written guard: accepts anything the model emitted, returns a ReceiptAnalysis whose totalPaise is either a
 * billable integer or null. Throws ai_invalid only when the reply is not an object at all — a receipt it could not
 * read is a normal outcome (the worker types the amount), not an error.
 */
export function normalizeReceipt(raw: unknown, model: string): ReceiptAnalysis {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReceiptError("ai_invalid", "not an object");
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  const looksLikeReceipt = truthy(o.looksLikeReceipt);
  const items: ReceiptItem[] = (Array.isArray(o.items) ? o.items : [])
    .map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>) : {}))
    .map((i) => ({ name: clean(i.name, 60) ?? "", qty: qtyOf(i.qty), amountPaise: toPaise(i.amount) }))
    .filter((i) => i.name !== "" && i.amountPaise !== null && i.amountPaise >= 0)
    .slice(0, MAX_ITEMS);

  let totalPaise = toPaise(o.total);
  if (totalPaise !== null && totalPaise <= 0) {
    notes.push("The reader could not make out a usable total on this photo.");
    totalPaise = null;
  } else if (totalPaise !== null && totalPaise > MAX_REIMBURSEMENT_PAISE) {
    // A misread decimal point is the likeliest cause, so the figure is dropped rather than shown as a claim.
    notes.push(`The reader made the total ${formatPaise(totalPaise)}, over the ${formatPaise(MAX_REIMBURSEMENT_PAISE)} limit for one receipt, so it was not used.`);
    totalPaise = null;
  }
  if (!looksLikeReceipt) {
    notes.push("This photo does not look like a shop receipt to the reader, so no amount was taken from it.");
    totalPaise = null;
  }

  // Lines and total disagreeing means one of them was misread. Keep the printed total, but say so out loud.
  const summed = items.reduce((n, i) => n + (i.amountPaise ?? 0), 0);
  if (totalPaise !== null && summed > 0 && Math.abs(summed - totalPaise) * 5 > totalPaise) {
    notes.push(`The lines add up to ${formatPaise(summed)} but the total reads ${formatPaise(totalPaise)} — check the photo before approving.`);
  }

  return {
    looksLikeReceipt,
    merchant: clean(o.merchant, 60),
    purchasedAt: clean(o.purchasedAt, 40),
    items,
    totalPaise,
    confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
    model,
    source: "ollama",
    note: notes.join(" ") || null,
  };
}

/** The record kept when no model read the photo: honest about having read nothing, so the customer is not misled. */
export function manualAnalysis(note: string): ReceiptAnalysis {
  return { looksLikeReceipt: false, merchant: null, purchasedAt: null, items: [], totalPaise: null, confidence: 0, model: "none", source: "manual", note };
}

async function generate(model: string, bytes: Buffer, ms: number): Promise<ReceiptAnalysis> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, prompt: receiptPrompt(), images: [bytes.toString("base64")], // raw base64: Ollama rejects a data: prefix
        stream: false, format: receiptSchema(), keep_alive: "10m", options: { temperature: 0 },
      }),
    });
    if (res.status === 404) throw new ReceiptError("ai_unavailable", `model ${model} is not installed`);
    if (!res.ok) throw new ReceiptError("ai_unavailable", `ollama answered ${res.status}`);
    const body = (await res.json()) as { response?: unknown };
    if (typeof body.response !== "string") throw new ReceiptError("ai_invalid", "no response text");
    let parsed: unknown;
    try { parsed = JSON.parse(body.response); } catch { throw new ReceiptError("ai_invalid", "model did not return JSON"); }
    return normalizeReceipt(parsed, model);
  } catch (e) {
    if (e instanceof ReceiptError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ReceiptError("ai_unavailable", aborted ? `${model} timed out after ${ms} ms` : `cannot reach Ollama at ${ollamaUrl()}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a receipt image. Walks the model chain; throws ReceiptError when no installed model could read it. */
export async function analyseReceipt(bytes: Buffer, mime: string): Promise<ReceiptAnalysis> {
  if (!(RECEIPT_TYPES as readonly string[]).includes(mime)) throw new ReceiptError("ai_invalid", `${mime} is not a receipt image`);
  const started = Date.now();
  const models = receiptModels();
  let invalid: ReceiptError | null = null;
  for (const model of models) {
    try {
      const a = await generate(model, bytes, timeoutMs());
      console.log(`[receipt] model=${model} total=${a.totalPaise ?? "-"} items=${a.items.length} ms=${Date.now() - started}`);
      return a;
    } catch (e) {
      const err = e instanceof ReceiptError ? e : new ReceiptError("ai_unavailable", String(e));
      if (err.code === "ai_invalid") invalid = err; // it answered, just badly: a better reader may still be installed
      console.warn(`[receipt] ${model}: ${err.message}`);
    }
  }
  throw invalid ?? new ReceiptError("ai_unavailable", `no vision model installed (tried ${models.join(", ")})`);
}

// ─── Claims: who may file one, who may decide it ──────────────────────────────────────────────────────────────

export type ReceiptFailReason =
  | "not_found" | "not_worker" | "not_customer" | "job_not_active"
  | "already_paid" | "payment_in_progress" | "too_many" | "amount_required" | "amount_invalid" | "already_decided";

export type SubmitResult =
  | { ok: true; reimbursement: Reimbursement; analysis: ReceiptAnalysis | null }
  | { ok: false; reason: ReceiptFailReason; analysis?: ReceiptAnalysis | null };
export type DecideResult =
  | { ok: true; reimbursement: Reimbursement; approvedPaise: number }
  | { ok: false; reason: ReceiptFailReason };
export type ReceiptsView = {
  role: "customer" | "worker";
  reimbursements: Reimbursement[];
  approvedPaise: number;   // already on the bill
  pendingPaise: number;    // waiting for the customer to look at it
  maxPerJob: number;
};

type Guard = { ok: true; request: HelpRequest } | { ok: false; reason: ReceiptFailReason };

/** Once money is moving or has moved, the bill is closed: nothing may be added to it from either side. */
function guardUnsettled(r: HelpRequest): Guard {
  if (r.paymentStatus === "paid" || r.paymentStatus === "refunded") return { ok: false, reason: "already_paid" };
  if (r.paymentStatus === "processing") return { ok: false, reason: "payment_in_progress" };
  return { ok: true, request: r };
}
/** Only the one worker who accepted this job — not a nearby provider, not the customer, not an admin. */
function guardWorker(r: HelpRequest | null, workerId: string): Guard {
  if (!r) return { ok: false, reason: "not_found" };
  if (!r.matchedHelperId || r.matchedHelperId !== workerId) return { ok: false, reason: "not_worker" };
  if (r.status !== "matched" && r.status !== "resolved") return { ok: false, reason: "job_not_active" };
  return guardUnsettled(r);
}
function guardCustomer(r: HelpRequest | null, customerId: string): Guard {
  if (!r) return { ok: false, reason: "not_found" };
  if (!r.requesterHelperId || r.requesterHelperId !== customerId) return { ok: false, reason: "not_customer" };
  return guardUnsettled(r);
}

/**
 * Claims that can still cost the customer money. A rejected receipt hands its slot back: one blurred photo should
 * not burn a claim the worker is genuinely owed, and a rejected claim can never reach the bill anyway.
 */
async function liveClaims(requestId: string): Promise<Reimbursement[]> {
  return (await getStore().listReimbursements(requestId)).filter((r) => r.status !== "rejected");
}

/** What the customer owes on top of the work. Approved receipts only, and they are paid on without commission. */
export async function approvedReimbursementPaise(requestId: string): Promise<number> {
  return (await getStore().listReimbursements(requestId)).reduce((n, r) => n + (r.status === "approved" ? r.claimedPaise : 0), 0);
}

/**
 * The vision call and the GridFS write, injected. Production passes nothing; tests pass stubs so the whole
 * submission path — authorisation, the per-job cap, the amount rules — can run with no model and no MongoDB.
 */
export type ReceiptDeps = {
  analyse: (bytes: Buffer, mime: string) => Promise<ReceiptAnalysis>;
  save: (bytes: Buffer, meta: { requestId: string; workerId: string; mime: string }) => Promise<string>;
};
const liveDeps: ReceiptDeps = { analyse: analyseReceipt, save: saveReceipt };

/**
 * The worker files a receipt. `rupees` is the worker's own figure and wins over the model's when given; without
 * either figure the claim is refused ("amount_required") rather than guessed, which is also the path taken on a
 * machine with no vision model installed.
 */
export async function submitReceipt(input: {
  requestId: string; workerId: string; bytes: Buffer; mime: string; size: number; rupees?: unknown; note?: unknown;
}, deps: ReceiptDeps = liveDeps): Promise<SubmitResult> {
  const store = getStore();
  // Checked before the model runs so a stranger's upload costs a database read, not a minute of GPU.
  const pre = guardWorker(await store.getRequest(input.requestId), input.workerId);
  if (!pre.ok) return pre;
  if ((await liveClaims(input.requestId)).length >= MAX_REIMBURSEMENTS_PER_JOB) return { ok: false, reason: "too_many" };

  let analysis: ReceiptAnalysis;
  try {
    analysis = await deps.analyse(input.bytes, input.mime);
  } catch (e) {
    const unavailable = e instanceof ReceiptError && e.code === "ai_unavailable";
    analysis = manualAnalysis(unavailable
      ? "No receipt reader is installed on this server, so the amount is the worker's own figure — the photo is the evidence."
      : "The receipt reader could not make sense of this photo, so the amount is the worker's own figure.");
  }

  const given = input.rupees !== undefined && input.rupees !== null && input.rupees !== "";
  const typed = given ? parseRupeesToPaise(input.rupees) : null;
  if (given && typed === null) return { ok: false, reason: "amount_invalid", analysis };
  const claimedPaise = typed ?? analysis.totalPaise;
  if (claimedPaise === null) return { ok: false, reason: "amount_required", analysis };
  if (claimedPaise <= 0 || claimedPaise > MAX_REIMBURSEMENT_PAISE) return { ok: false, reason: "amount_invalid", analysis };

  const created = await withRequestLock(input.requestId, async (): Promise<{ ok: true; reimbursement: Reimbursement; request: HelpRequest } | { ok: false; reason: ReceiptFailReason }> => {
    // Re-checked under the lock: the job may have been paid, or the fifth receipt filed, during the model call.
    const g = guardWorker(await store.getRequest(input.requestId), input.workerId);
    if (!g.ok) return g;
    if ((await liveClaims(input.requestId)).length >= MAX_REIMBURSEMENTS_PER_JOB) return { ok: false, reason: "too_many" };
    const fileId = await deps.save(input.bytes, { requestId: input.requestId, workerId: input.workerId, mime: input.mime });
    const rb: Reimbursement = {
      id: randomUUID(), requestId: input.requestId, workerId: input.workerId, fileId, mime: input.mime, size: input.size,
      analysis, claimedPaise, note: clean(input.note, 140), status: "pending",
      createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
    };
    return { ok: true, reimbursement: await store.createReimbursement(rb), request: g.request };
  });
  if (!created.ok) return { ...created, analysis };
  emit("request:updated", { request: created.request }); // the customer's screen pulls the new claim
  return { ok: true, reimbursement: created.reimbursement, analysis };
}

/** The customer approves or rejects one claim. Nobody else decides, and a rejected claim never reaches the bill. */
export async function decideReceipt(input: { requestId: string; receiptId: string; customerId: string; action: "approve" | "reject" }): Promise<DecideResult> {
  const store = getStore();
  const done = await withRequestLock(input.requestId, async (): Promise<{ ok: true; reimbursement: Reimbursement; request: HelpRequest } | { ok: false; reason: ReceiptFailReason }> => {
    const g = guardCustomer(await store.getRequest(input.requestId), input.customerId);
    if (!g.ok) return g;
    const rb = await store.getReimbursement(input.receiptId);
    if (!rb || rb.requestId !== input.requestId) return { ok: false, reason: "not_found" };
    const status = input.action === "approve" ? "approved" : "rejected";
    // A double-tapped approve is the same approve; changing a decision is not allowed, so the bill cannot wobble.
    if (rb.status !== "pending") return rb.status === status ? { ok: true, reimbursement: rb, request: g.request } : { ok: false, reason: "already_decided" };
    const updated = await store.updateReimbursement(rb.id, { status, decidedAt: new Date().toISOString(), decidedBy: input.customerId });
    return updated ? { ok: true, reimbursement: updated, request: g.request } : { ok: false, reason: "not_found" };
  });
  if (!done.ok) return done;
  emit("request:updated", { request: done.request });
  return { ok: true, reimbursement: done.reimbursement, approvedPaise: await approvedReimbursementPaise(input.requestId) };
}

/** The claim list, for the two people entitled to it: the customer paying and the worker who filed them. */
export async function listReceipts(requestId: string, viewerId: string): Promise<{ ok: true; view: ReceiptsView } | { ok: false; reason: "not_found" | "forbidden" }> {
  const r = await getStore().getRequest(requestId);
  if (!r) return { ok: false, reason: "not_found" };
  const role = r.requesterHelperId === viewerId ? "customer" : r.matchedHelperId === viewerId ? "worker" : null;
  if (!role) return { ok: false, reason: "forbidden" };
  const reimbursements = await getStore().listReimbursements(requestId);
  const sum = (s: Reimbursement["status"]) => reimbursements.reduce((n, x) => n + (x.status === s ? x.claimedPaise : 0), 0);
  return { ok: true, view: { role, reimbursements, approvedPaise: sum("approved"), pendingPaise: sum("pending"), maxPerJob: MAX_REIMBURSEMENTS_PER_JOB } };
}

/** One claim, for the image route: the same two people, nobody else — a receipt carries a home address on it. */
export async function getReceiptFor(requestId: string, receiptId: string, viewerId: string): Promise<{ ok: true; reimbursement: Reimbursement } | { ok: false; reason: "not_found" | "forbidden" }> {
  const store = getStore();
  const r = await store.getRequest(requestId);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.requesterHelperId !== viewerId && r.matchedHelperId !== viewerId) return { ok: false, reason: "forbidden" };
  const rb = await store.getReimbursement(receiptId);
  if (!rb || rb.requestId !== requestId) return { ok: false, reason: "not_found" };
  return { ok: true, reimbursement: rb };
}
