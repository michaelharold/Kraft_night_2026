"use client";
/*
 * The money half of a finished job, on both screens: the worker naming their final charge and seeing what it
 * leaves them, and the customer reading the bill, deciding on the parts the worker bought, and paying it.
 *
 * Every figure here is computed by the server and printed with formatPaise. Nothing in this file adds two amounts
 * together — not the total, not the fee, not the payout — because a screen that does its own arithmetic will one
 * day disagree with the amount actually charged, and the person reading it has no way to tell which number is the
 * real one. The one place a rupee figure originates in the browser is the worker's own input, and even that is
 * echoed back through parseRupeesToPaise, the exact function the charge route parses it with, so the amount they
 * confirm is the amount that gets stored.
 *
 * The bill is polled, not pushed. request:updated does travel over SSE, but the bill is assembled from receipts
 * and payment records the snapshot does not carry, so both screens re-read /api/payments/bill every few seconds
 * while the job is live — and immediately after anything the person on that screen just did. Polling stops the
 * moment the bill is paid, because after that nothing about it can change.
 *
 * Razorpay's checkout.js is fetched on the tap that needs it and never from the layout: most sessions never open a
 * payment, and a third-party script on every page of a safety app is a cost paid by everyone for the few. When no
 * keys are configured the order comes back as provider "demo" with no key id, and this panel says so in plain
 * words before it settles anything — an unlabelled fake payment is the one thing it must never render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { CustomerReceiptCard, ReceiptUploader, WorkerReceiptCard } from "./ReceiptCard";
import { api } from "@/lib/client/api";
import { MAX_SERVICE_PAISE, MIN_SERVICE_PAISE, formatPaise, parseRupeesToPaise, type Settlement } from "@/lib/money";
import type { Bill } from "@/lib/payments";
import type { ReceiptsView } from "@/lib/receipts";
import type { RequestStatus } from "@/lib/types";

/** What the worker hands back to the screen that resolves the job, so its confirmation can name real amounts. */
export type DoneSummary = { grossPretty: string; payoutPretty: string } | null;

type OrderResponse = {
  orderId: string; amountPaise: number; currency: string; keyId: string | null;
  provider: "razorpay" | "demo"; reused: boolean; paymentId: string; bill: Bill;
};

// ─── The bill, shared by both screens ────────────────────────────────────────────────────────────────────────

/**
 * The live bill and the receipt claims for one job. Both endpoints answer for either side (the customer paying and
 * the worker who filed the claims), so one hook serves both panels.
 */
export function useMoney(requestId: string, live: boolean) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [receipts, setReceipts] = useState<ReceiptsView | null>(null);
  const [denied, setDenied] = useState(false);
  const paid = useRef(false);

  const reload = useCallback(async () => {
    const [b, c] = await Promise.all([
      api<{ bill: Bill }>(`/api/payments/bill?requestId=${encodeURIComponent(requestId)}`),
      api<ReceiptsView>(`/api/requests/${requestId}/receipts`),
    ]);
    if (b.ok) { setBill(b.data.bill); paid.current = b.data.bill.paid; }
    else if (b.status === 401 || b.status === 403) setDenied(true);
    if (c.ok) setReceipts(c.data);
  }, [requestId]);

  useEffect(() => {
    if (!live) return;
    void reload();
    const t = setInterval(() => { if (!paid.current) void reload(); }, 8000);
    return () => clearInterval(t);
  }, [live, reload]);

  return { bill, receipts, denied, reload };
}

function Line({ label, sub, value, strong = false }: { label: string; sub?: string | null; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <p className={`text-sm ${strong ? "font-display font-bold text-resq-navy" : "text-resq-navy"}`}>{label}</p>
        {sub && <p className="truncate text-xs text-resq-slate">{sub}</p>}
      </div>
      <p className={`shrink-0 font-mono ${strong ? "text-xl font-bold text-resq-navy" : "text-sm text-resq-navy"}`}>{value}</p>
    </div>
  );
}

/** The itemised bill: the work, then one line per approved receipt. The lines always sum to the total by design. */
function BillLines({ bill, settlement, workerName }: { bill: Bill; settlement: Settlement; workerName: string }) {
  return (
    <div className="space-y-2">
      <Line label={`${workerName}'s work`} value={formatPaise(settlement.servicePaise)} />
      {bill.items.map((it) => <Line key={it.id} label={it.label} sub={it.note} value={formatPaise(it.amountPaise)} />)}
      <div className="border-t border-slate-200 pt-2">
        <Line label="Total" value={formatPaise(settlement.grossPaise)} strong />
      </div>
    </div>
  );
}

// ─── Worker: name the charge, watch the settlement, file receipts ────────────────────────────────────────────

const CHARGE_ERRORS: Record<string, string> = {
  amount_invalid: "Enter the amount in rupees, for example 750 or 750.50.",
  amount_out_of_range: `The charge must be between ${formatPaise(MIN_SERVICE_PAISE)} and ${formatPaise(MAX_SERVICE_PAISE)}.`,
  forbidden: "This job is no longer yours.",
  wrong_status: "This job is no longer open for a charge.",
  already_paid: "The customer has already paid for this job.",
  not_service: "This job isn’t a paid service.",
  not_found: "This job no longer exists.",
  bad_json: "Couldn’t send that amount. Try again.",
};

/** What the worker actually takes home, in the server's own figures. Never recomputed here. */
function WorkerSettlement({ s, customerName }: { s: Settlement; customerName: string }) {
  return (
    <div className="rounded-xl border border-resq-green/40 bg-resq-green-light p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-resq-green">You receive</p>
      <p className="font-display text-3xl font-bold text-resq-navy">{formatPaise(s.payoutPaise)}</p>
      <p className="mt-1 text-xs leading-snug text-resq-slate">
        {formatPaise(s.servicePaise)} for the work − {formatPaise(s.commissionPaise)} platform fee ({s.commissionPct}%)
        {s.reimbursementPaise > 0 ? ` + ${formatPaise(s.reimbursementPaise)} for approved parts` : ""}
      </p>
      <p className="mt-2 text-xs text-resq-navy">
        {customerName} is asked for <strong>{formatPaise(s.grossPaise)}</strong>. Your share lands in your Sahaya wallet the moment they pay.
      </p>
    </div>
  );
}

/**
 * "Mark as done" for a paid service, which is really three things: the charge, the parts, and the resolve. The
 * charge is POSTed before the job is resolved (the route accepts it while the job is still matched), so the
 * settlement the worker confirms is one the server has already computed and stored — the button that follows only
 * closes the job.
 */
export function WorkerMoneyPanel({ requestId, rateHint, customerName, onDone }: {
  requestId: string; rateHint: string | null; customerName: string; onDone: (summary: DoneSummary) => void | Promise<void>;
}) {
  const { bill, receipts, reload } = useMoney(requestId, true);
  const [step, setStep] = useState<"idle" | "amount" | "confirm">("idle");
  const [rupees, setRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charged, setCharged] = useState<Bill | null>(null);
  const restored = useRef(false);

  const claims = receipts?.reimbursements ?? [];
  const filed = claims.filter((r) => r.status !== "rejected").length;       // rejected claims hand their slot back
  const typed = parseRupeesToPaise(rupees.trim());
  const usable = typed !== null && typed >= MIN_SERVICE_PAISE && typed <= MAX_SERVICE_PAISE;
  // The stored bill wins over the charge response: a receipt approved since then is already on it.
  const settlement = bill?.settlement ?? charged?.settlement ?? null;

  // A charge survives a reload, so someone who named their amount and then closed the tab comes back to the
  // confirmation rather than to an empty field they have to fill in a second time.
  useEffect(() => {
    if (restored.current || !bill?.settlement) return;
    restored.current = true;
    setCharged(bill);
    setStep("confirm");
  }, [bill]);

  const sendCharge = async () => {
    setBusy(true); setError(null);
    const r = await api<{ servicePretty: string; bill: Bill }>(`/api/requests/${requestId}/charge`, { body: { rupees: rupees.trim() } });
    setBusy(false);
    if (!r.ok) { setError(CHARGE_ERRORS[r.error] ?? "Couldn’t save that amount. Try again."); return; }
    setCharged(r.data.bill);
    restored.current = true;
    setStep("confirm");
    void reload();
  };

  const finish = async () => {
    setBusy(true);
    await onDone(settlement ? { grossPretty: formatPaise(settlement.grossPaise), payoutPretty: formatPaise(settlement.payoutPaise) } : null);
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-display font-bold text-resq-navy">Parts you bought</h3>
          {bill && bill.reimbursementPaise > 0 && (
            <span className="rounded-full bg-resq-green-light px-2.5 py-0.5 text-xs font-semibold text-resq-green">{formatPaise(bill.reimbursementPaise)} approved</span>
          )}
        </div>
        {claims.length > 0 && <ul className="mb-2 space-y-2">{claims.map((c) => <WorkerReceiptCard key={c.id} requestId={requestId} r={c} />)}</ul>}
        <ReceiptUploader requestId={requestId} filed={filed} max={receipts?.maxPerJob ?? 5} onFiled={reload} />
        <p className="mt-2 text-xs text-resq-slate">{customerName} approves each receipt. Approved parts are added to your payout in full — Sahaya takes no cut of them.</p>
      </section>

      {step === "idle" && (
        <button onClick={() => { setError(null); setStep("amount"); }} className="min-h-14 w-full rounded-2xl bg-success-gradient font-display text-lg font-bold text-white">
          Mark as done
        </button>
      )}

      {step === "amount" && (
        <section className="animate-slide-up space-y-3 rounded-2xl border-2 border-resq-green bg-white p-4">
          <div>
            <h3 className="font-display text-lg font-bold text-resq-navy">What are you charging for the work?</h3>
            <p className="text-xs text-resq-slate">{rateHint ? `Your listed range for this service: ${rateHint}.` : "Your final figure for the work itself."} Parts you bought are added separately.</p>
          </div>
          <label className="block text-xs font-semibold text-resq-slate">
            Amount in rupees
            <input value={rupees} onChange={(e) => setRupees(e.target.value)} inputMode="decimal" maxLength={10} placeholder="e.g. 750" autoFocus disabled={busy}
              className="mt-1 min-h-14 w-full rounded-xl border border-slate-200 px-4 font-mono text-2xl font-bold text-resq-navy outline-none focus:ring-2 focus:ring-resq-green/30" />
          </label>
          {/* Echoed through the same parser the route uses, so what they read here is what gets stored. */}
          <p className="text-sm text-resq-slate">
            {rupees.trim() === "" ? "The customer sees this amount on their screen."
              : usable ? <>You are charging <strong className="font-mono text-resq-navy">{formatPaise(typed!)}</strong> for the work.</>
              : typed === null ? CHARGE_ERRORS.amount_invalid : CHARGE_ERRORS.amount_out_of_range}
          </p>
          {error && <p role="alert" className="rounded-xl bg-resq-red-light p-3 text-sm font-medium text-resq-red">{error}</p>}
          <div className="grid grid-cols-[1fr_1.4fr] gap-2">
            <button onClick={() => setStep(settlement ? "confirm" : "idle")} disabled={busy} className="min-h-14 rounded-2xl border border-slate-200 text-sm font-semibold text-resq-slate disabled:opacity-60">Back</button>
            <button onClick={() => void sendCharge()} disabled={busy || !usable} className="min-h-14 rounded-2xl bg-resq-navy px-2 font-display text-base font-bold text-white disabled:opacity-50">
              {busy ? "Saving…" : "Confirm amount"}
            </button>
          </div>
        </section>
      )}

      {step === "confirm" && settlement && (
        <section className="animate-slide-up space-y-3 rounded-2xl border-2 border-resq-green bg-white p-4">
          <WorkerSettlement s={settlement} customerName={customerName} />
          {error && <p role="alert" className="rounded-xl bg-resq-red-light p-3 text-sm font-medium text-resq-red">{error}</p>}
          <button onClick={() => void finish()} disabled={busy} className="min-h-14 w-full rounded-2xl bg-success-gradient font-display text-lg font-bold text-white disabled:opacity-60">
            {busy ? "Closing the job…" : "Mark as done & send the bill"}
          </button>
          <button onClick={() => { setStep("amount"); setError(null); }} disabled={busy} className="min-h-12 w-full rounded-xl text-sm font-semibold text-resq-slate underline disabled:opacity-50">
            Change the amount
          </button>
        </section>
      )}
    </div>
  );
}

// ─── Customer: review the receipts, read the bill, pay it ────────────────────────────────────────────────────

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
type CheckoutResult = { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string };
type CheckoutOptions = {
  key: string; amount: number; currency: string; name: string; description: string; order_id: string;
  theme?: { color: string }; handler: (r: CheckoutResult) => void; modal?: { ondismiss: () => void };
};
type CheckoutCtor = new (o: CheckoutOptions) => { open: () => void };
declare global { interface Window { Razorpay?: CheckoutCtor } }

let pending: Promise<CheckoutCtor | null> | null = null;
/** Razorpay's script, fetched on the tap that needs it. Resolves null when it cannot be reached, so the caller can say so. */
function loadCheckout(): Promise<CheckoutCtor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  pending ??= new Promise<CheckoutCtor | null>((resolve) => {
    const s = document.createElement("script");
    s.src = CHECKOUT_SRC;
    s.async = true;
    s.onload = () => resolve(window.Razorpay ?? null);
    s.onerror = () => { pending = null; resolve(null); }; // a retry after a dropped connection should fetch it again
    document.head.appendChild(s);
  });
  return pending;
}

const ORDER_ERRORS: Record<string, string> = {
  not_resolved: "Your provider hasn’t marked this job as done yet.",
  amount_not_set: "Waiting for your provider to enter their final amount.",
  already_paid: "This job is already paid.",
  no_worker: "No provider is on this job.",
  forbidden: "Only the person who booked this job can pay for it.",
  gateway_unavailable: "The payment gateway didn’t answer. Try again in a moment.",
  not_found: "This job no longer exists.",
};
const VERIFY_ERRORS: Record<string, string> = {
  signature_invalid: "That confirmation didn’t check out, so nothing was settled here. If the money did leave your account, the gateway’s own webhook will settle it — check back in a minute.",
  payment_id_missing: "The gateway didn’t return a payment id, so nothing was settled.",
  gateway_unavailable: "The payment gateway didn’t answer. Nothing was charged.",
  forbidden: "This payment belongs to someone else.",
  not_found: "That order has expired. Start the payment again.",
};

/** Paid: what the customer paid and where it went. The split is the server's, read back off the settled bill. */
function PaidCard({ bill, settlement, workerName }: { bill: Bill; settlement: Settlement; workerName: string }) {
  return (
    <section className="card-shadow animate-slide-up overflow-hidden rounded-2xl border border-resq-green/40 bg-white">
      <div className="bg-success-gradient px-5 py-4 text-white">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-white/80"><Icon.Check size={14} />Paid</p>
        <p className="font-display text-3xl font-bold">{formatPaise(settlement.grossPaise)}</p>
        <p className="text-sm text-white/80">to {workerName}{bill.paidAt ? ` · ${new Date(bill.paidAt).toLocaleString([], { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}` : ""}</p>
      </div>
      <div className="space-y-2 p-4">
        <BillLines bill={bill} settlement={settlement} workerName={workerName} />
        <div className="space-y-1.5 rounded-xl bg-slate-50 p-3">
          <Line label={`${workerName} received`} value={formatPaise(settlement.payoutPaise)} />
          <Line label={`Sahaya platform fee (${settlement.commissionPct}% of the work)`} value={formatPaise(settlement.commissionPaise)} />
        </div>
        {bill.provider === "demo" && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Demo payment — no real money moved. This server has no Razorpay keys configured.</p>}
      </div>
    </section>
  );
}

/**
 * The customer's side: receipts to decide on while the job runs, then the bill, the payment and the record of it.
 * It renders nothing at all until there is something to decide or to pay, and nothing ever for someone the bill
 * routes refuse — an onlooker on a shared screen is told by silence, not by an error.
 */
export function PaymentPanel({ requestId, workerName, status }: { requestId: string; workerName: string; status: RequestStatus }) {
  const live = status === "matched" || status === "resolved";
  const { bill, receipts, denied, reload } = useMoney(requestId, live);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "ordering" | "demo" | "checkout" | "verifying">("idle");
  const [order, setOrder] = useState<OrderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const claims = receipts?.reimbursements ?? [];
  const pendingClaims = claims.filter((c) => c.status === "pending");
  // Decided claims are shown back only while the job runs; once there is a bill, its lines are the record.
  const decidedClaims = status === "matched" ? claims.filter((c) => c.status !== "pending") : [];
  const settlement = bill?.settlement ?? null;
  // The server closes the bill while an order is open or once it is paid; say so rather than let a tap fail.
  const locked = bill?.paymentStatus === "processing" || bill?.paid === true;

  const decide = async (receiptId: string, action: "approve" | "reject") => {
    setDeciding(receiptId); setDecideError(null);
    const r = await api(`/api/requests/${requestId}/receipts/${receiptId}`, { body: { action } });
    if (!r.ok) setDecideError(r.error === "already_paid" ? "This job is already paid, so the bill is closed." : r.error === "payment_in_progress" ? "A payment is being set up right now, so the bill is closed." : "Couldn’t send that decision. Try again.");
    await reload();
    setDeciding(null);
  };

  /** The browser's half of the confirmation. The webhook settles the same payment independently; either may win. */
  const confirm = async (body: Record<string, string>) => {
    setStage("verifying"); setError(null);
    const r = await api<{ alreadyPaid: boolean }>("/api/payments/verify", { body });
    await reload();
    setStage("idle");
    if (!r.ok) setError(VERIFY_ERRORS[r.error] ?? "Couldn’t confirm that payment. Refresh in a moment — if it went through, it will show here.");
  };

  const pay = async () => {
    setError(null); setStage("ordering");
    const o = await api<OrderResponse>("/api/payments/order", { body: { requestId } });
    if (!o.ok) { setStage("idle"); setError(ORDER_ERRORS[o.error] ?? "Couldn’t start that payment. Try again."); void reload(); return; }
    setOrder(o.data);
    // No keys on this server: there is no gateway to open, so say so and let them settle it deliberately.
    if (o.data.provider === "demo" || !o.data.keyId) { setStage("demo"); return; }
    const Checkout = await loadCheckout();
    if (!Checkout) { setStage("idle"); setError("Couldn’t load the payment window. Check your connection and try again."); return; }
    setStage("checkout");
    new Checkout({
      key: o.data.keyId, amount: o.data.amountPaise, currency: o.data.currency || "INR",
      name: "Sahaya", description: `${workerName} · ${formatPaise(o.data.amountPaise)}`, order_id: o.data.orderId,
      theme: { color: "#1E3A5F" },
      handler: (res) => void confirm({
        razorpay_order_id: res.razorpay_order_id ?? o.data.orderId,
        razorpay_payment_id: res.razorpay_payment_id ?? "",
        razorpay_signature: res.razorpay_signature ?? "",
      }),
      modal: { ondismiss: () => setStage("idle") },
    }).open();
  };

  if (!live || denied) return null;

  return (
    <>
      {pendingClaims.length + decidedClaims.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="font-display text-lg font-bold text-resq-navy">{workerName} bought parts for this job</h3>
            <p className="text-sm text-resq-slate">
              {pendingClaims.length === 0 ? "Approved parts are added to your final bill in full — Sahaya takes no commission on them."
                : locked ? "The bill is closed while your payment is being settled, so these can no longer be decided here."
                : "Look at the bill they photographed. Nothing is added to what you owe until you approve it."}
            </p>
          </div>
          <ul className="space-y-3">
            {pendingClaims.map((c) => (
              <CustomerReceiptCard key={c.id} requestId={requestId} r={c} workerName={workerName} busy={locked || deciding === c.id} onDecide={(action) => void decide(c.id, action)} />
            ))}
            {decidedClaims.map((c) => (
              <CustomerReceiptCard key={c.id} requestId={requestId} r={c} workerName={workerName} busy onDecide={() => undefined} />
            ))}
          </ul>
          {decideError && <p role="alert" className="rounded-xl bg-resq-red-light p-3 text-sm font-medium text-resq-red">{decideError}</p>}
        </section>
      )}

      {status === "resolved" && (
        bill && settlement && bill.paid ? <PaidCard bill={bill} settlement={settlement} workerName={workerName} /> : (
          <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-5">
            <h3 className="font-display text-lg font-bold text-resq-navy">Pay {workerName}</h3>
            {!bill ? (
              <p className="mt-2 text-sm text-resq-slate">Loading the bill…</p>
            ) : !settlement ? (
              <p className="mt-2 rounded-xl bg-slate-50 p-3 text-sm text-resq-slate">
                Waiting for {workerName} to enter their final amount. It appears here the moment they do — nothing to pay yet.
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-resq-slate">What you owe, line by line.</p>
                <div className="mt-3"><BillLines bill={bill} settlement={settlement} workerName={workerName} /></div>
                {pendingClaims.length > 0 && (
                  <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                    {pendingClaims.length} receipt{pendingClaims.length > 1 ? "s are" : " is"} still waiting for your decision above. Anything you decline is never added to this total.
                  </p>
                )}
                {error && <p role="alert" className="mt-3 rounded-xl bg-resq-red-light p-3 text-sm font-medium text-resq-red">{error}</p>}

                {stage === "demo" && order ? (
                  <div className="animate-slide-up mt-3 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
                    <p className="font-display font-bold text-amber-900">Demo payment — no money moves</p>
                    <p className="mt-1 text-xs leading-snug text-amber-900">
                      This server has no Razorpay keys, so there is no real checkout to open. Confirming records {formatPaise(order.amountPaise)} as paid and credits {workerName}’s Sahaya wallet, exactly as a real payment would — but no bank is involved.
                    </p>
                    <div className="mt-3 grid grid-cols-[1fr_1.4fr] gap-2">
                      <button onClick={() => setStage("idle")} className="min-h-14 rounded-2xl border border-amber-300 bg-white text-sm font-semibold text-amber-900">Cancel</button>
                      <button onClick={() => void confirm({ orderId: order.orderId })} className="min-h-14 rounded-2xl bg-resq-navy px-2 font-display text-sm font-bold text-white">Confirm demo payment</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button onClick={() => void pay()} disabled={stage !== "idle"}
                      className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-resq-navy font-display text-lg font-bold text-white shadow-lg disabled:opacity-60">
                      {stage === "idle" ? <>Pay {formatPaise(settlement.grossPaise)}</> : stage === "ordering" ? "Opening…" : stage === "checkout" ? "Finish in the payment window" : "Confirming…"}
                    </button>
                    <p className="mt-2 text-center text-xs text-resq-slate">
                      {bill.provider === "demo"
                        ? "Demo mode: no Razorpay keys on this server, so no real money moves."
                        : `Card, UPI or netbanking via Razorpay. ${workerName} is paid ${formatPaise(settlement.payoutPaise)}; Sahaya keeps ${formatPaise(settlement.commissionPaise)} of the work as its fee.`}
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        )
      )}
    </>
  );
}
