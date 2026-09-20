"use client";
/*
 * Receipts for parts a worker bought mid-job, on both sides of the job: the worker files one and watches it, the
 * customer looks at the photograph and decides.
 *
 * The rule this file exists to hold on screen: the vision model's reading is EVIDENCE shown beside the photo, never
 * a figure that moves on its own. So a receipt card puts the image first and the numbers second, labels the amount
 * as the worker's claim rather than the AI's, and keeps a quiet "read by <model>" under the reading so nobody
 * mistakes a 3-billion-parameter guess at a crumpled thermal print for a verified extract. lib/receipts.ts has
 * already clamped the amounts and written the caveats; the only work left here is to not overstate them.
 *
 * Every rupee figure arrives from the server as integer paise and is printed with formatPaise. Nothing in this file
 * adds two amounts together — a number that is not on the record does not appear on the card.
 *
 * The uploader deliberately keeps the chosen photo after a refusal: "the reader could not find a total" (422
 * amount_required) is the ordinary outcome on a faded bill, or on a laptop with no vision model installed at all,
 * and the fix is for the worker to type the amount and send the SAME photo again — not to go and find the paper a
 * second time in somebody's kitchen.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { getHelperToken } from "@/lib/client/api";
import { formatPaise } from "@/lib/money";
import type { ReceiptAnalysis, Reimbursement } from "@/lib/types";

/** The image route authorises with this window's session, and an <img> cannot send a header — hence ?s= (as JobBrief does). */
const imageUrl = (requestId: string, receiptId: string) =>
  `/api/requests/${requestId}/receipts/${receiptId}/image?s=${encodeURIComponent(typeof window === "undefined" ? "none" : getHelperToken() ?? "none")}`;

const STATUS = {
  pending: { label: "Waiting for customer", cls: "bg-amber-50 text-amber-700", icon: <Icon.Clock size={12} /> },
  approved: { label: "Approved · on the bill", cls: "bg-resq-green-light text-resq-green", icon: <Icon.Check size={12} /> },
  rejected: { label: "Declined", cls: "bg-slate-100 text-resq-slate", icon: <Icon.X size={12} /> },
} as const;

export function ReceiptStatus({ status }: { status: Reimbursement["status"] }) {
  const s = STATUS[status];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}>{s.icon}{s.label}</span>;
}

/** What the model made of the photo. Advisory throughout: the totals here are captioned, never presented as the bill. */
export function ReceiptReading({ a }: { a: ReceiptAnalysis | null }) {
  if (!a) return null;
  const read = a.source === "ollama" && a.model !== "none";
  return (
    <div className="rounded-xl border border-resq-cyan/30 bg-resq-cyan-light/70 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-resq-cyan"><Icon.Activity size={12} />What the AI read</p>
      {a.merchant && <p className="mt-1 font-display text-sm font-bold text-resq-navy">{a.merchant}</p>}
      {a.purchasedAt && <p className="text-xs text-resq-slate">{a.purchasedAt}</p>}
      {a.items.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {a.items.map((it, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-resq-navy">{it.name}{it.qty && it.qty > 1 ? ` ×${it.qty}` : ""}</span>
              <span className="shrink-0 font-mono text-xs text-resq-slate">{it.amountPaise === null ? "–" : formatPaise(it.amountPaise)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 flex items-baseline justify-between gap-3 border-t border-resq-cyan/25 pt-2 text-sm">
        <span className="font-semibold text-resq-navy">Total it read</span>
        <span className="shrink-0 font-mono font-bold text-resq-navy">{a.totalPaise === null ? "none it could make out" : formatPaise(a.totalPaise)}</span>
      </p>
      {/* Curated server-side in lib/receipts.ts — the model never writes copy that reaches this line. */}
      {a.note && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs leading-snug text-amber-900">{a.note}</p>}
      <p className="mt-2 text-[11px] text-resq-slate">
        {read ? `Read by ${a.model}, running on this device${a.confidence > 0 ? ` · ${Math.round(a.confidence * 100)}% sure of the total` : ""}` : "No receipt reader ran on this photo — the amount is the worker's own figure."}
      </p>
    </div>
  );
}

/** The worker's own claim, as they see it while they wait for the customer to look at it. */
export function WorkerReceiptCard({ requestId, r }: { requestId: string; r: Reimbursement }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-start gap-3 p-3">
        <a href={imageUrl(requestId, r.id)} target="_blank" rel="noopener noreferrer" className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(requestId, r.id)} alt="The receipt you photographed" className="h-full w-full object-cover" />
        </a>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold text-resq-navy">{formatPaise(r.claimedPaise)}</p>
          {r.note && <p className="truncate text-xs text-resq-slate">{r.note}</p>}
          <div className="mt-1.5"><ReceiptStatus status={r.status} /></div>
        </div>
      </div>
      {r.analysis && (
        <div className="px-3 pb-3">
          <button onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-1.5 text-left text-xs font-semibold text-resq-cyan">
            <Icon.Activity size={13} />{open ? "Hide what the AI read" : "See what the AI read"}
          </button>
          {open && <ReceiptReading a={r.analysis} />}
        </div>
      )}
    </li>
  );
}

/**
 * The customer's review card — the moment the whole feature exists for. The photo is large because the photo is
 * what they are being asked to believe; the AI's reading sits under it as a second opinion, and the two buttons
 * are the same size so neither one is the nudge.
 */
export function CustomerReceiptCard({ requestId, r, workerName, busy, onDecide }: {
  requestId: string; r: Reimbursement; workerName: string; busy: boolean; onDecide: (action: "approve" | "reject") => void;
}) {
  if (r.status !== "pending") {
    return (
      <li className={`flex items-center gap-3 rounded-2xl border p-3 ${r.status === "approved" ? "border-resq-green/40 bg-resq-green-light" : "border-slate-200 bg-slate-50"}`}>
        <a href={imageUrl(requestId, r.id)} target="_blank" rel="noopener noreferrer" className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(requestId, r.id)} alt="Receipt" className="h-full w-full object-cover" />
        </a>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-resq-navy">{r.analysis?.merchant ?? "Parts bought for this job"}</p>
          <ReceiptStatus status={r.status} />
        </div>
        <span className={`shrink-0 font-mono text-sm font-bold ${r.status === "approved" ? "text-resq-navy" : "text-slate-400 line-through"}`}>{formatPaise(r.claimedPaise)}</span>
      </li>
    );
  }
  return (
    <li className="card-shadow animate-slide-up overflow-hidden rounded-2xl border-2 border-amber-300 bg-white">
      <div className="flex items-center gap-2 bg-amber-50 px-4 py-2.5">
        <Icon.AlertTriangle size={15} className="shrink-0 text-amber-700" />
        <p className="text-xs font-bold uppercase tracking-wider text-amber-800">Needs your approval</p>
      </div>
      <a href={imageUrl(requestId, r.id)} target="_blank" rel="noopener noreferrer" className="block bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl(requestId, r.id)} alt={`Receipt ${workerName} photographed`} className="h-56 w-full object-contain" />
      </a>
      <div className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-xl font-bold text-resq-navy">{formatPaise(r.claimedPaise)}</p>
            <p className="text-xs text-resq-slate">{workerName} is claiming this for parts</p>
          </div>
          <span className="shrink-0 text-xs text-resq-slate">Tap the photo to enlarge</span>
        </div>
        {r.note && <p className="rounded-xl bg-slate-50 p-3 text-sm text-resq-navy">“{r.note}”</p>}
        <ReceiptReading a={r.analysis} />
        <p className="text-xs text-resq-slate">Approve and it is added to your total in full — Sahaya takes no commission on parts. Decline and you pay only for the work.</p>
        <div className="grid grid-cols-2 gap-2">
          <button disabled={busy} onClick={() => onDecide("approve")}
            className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-success-gradient font-display font-bold text-white shadow disabled:opacity-60">
            <Icon.Check size={18} />Approve
          </button>
          <button disabled={busy} onClick={() => onDecide("reject")}
            className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border-2 border-slate-200 font-display font-bold text-resq-slate disabled:opacity-60">
            <Icon.X size={18} />Decline
          </button>
        </div>
      </div>
    </li>
  );
}

const UPLOAD_ERRORS: Record<string, string> = {
  amount_required: "The reader couldn’t find a total on that photo. Type the amount printed on it and send the same photo again.",
  amount_invalid: "Enter the amount in rupees, for example 450 or 450.50.",
  too_many: "You have already filed the most receipts allowed on one job.",
  file_missing: "Choose a photo of the receipt first.",
  file_type_invalid: "That file isn’t a photo. Use a JPEG, PNG or WebP.",
  file_size_invalid: "That photo is too big — the limit is 6 MB.",
  already_paid: "This job is already paid, so nothing more can be added to the bill.",
  payment_in_progress: "The customer is paying right now, so the bill is closed.",
  job_not_active: "This job is no longer open for new receipts.",
  not_worker: "This job isn’t yours.",
};

/**
 * File one receipt. The amount is optional on the first try — the model usually reads it — and becomes required
 * the moment the model comes back without one, which is the 422 this form is built around.
 */
export function ReceiptUploader({ requestId, filed, max, onFiled }: {
  requestId: string; filed: number; max: number; onFiled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [rupees, setRupees] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failed, setFailed] = useState<{ text: string; analysis: ReceiptAnalysis | null } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [sending]);

  const full = filed >= max;
  const pick = (f: File) => {
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    setFile(f);
    setFailed(null);
  };
  const reset = () => {
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return null; });
    setFile(null); setRupees(""); setNote(""); setFailed(null); setOpen(false);
  };

  const send = async () => {
    if (!file) return;
    setSending(true); setElapsed(0); setFailed(null);
    const fd = new FormData();
    fd.append("file", file);
    if (rupees.trim()) fd.append("rupees", rupees.trim());
    if (note.trim()) fd.append("note", note.trim());
    let res: Response | null = null;
    let body: { error?: string; analysis?: ReceiptAnalysis | null } = {};
    try {
      res = await fetch(`/api/requests/${requestId}/receipts`, { method: "POST", body: fd, headers: { "x-resq-session": getHelperToken() ?? "none" } });
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch { /* offline: handled below */ }
    setSending(false);
    if (res?.ok) { reset(); onFiled(); return; }
    const code = body.error ?? "network";
    setFailed({ text: UPLOAD_ERRORS[code] ?? "Couldn’t send that receipt. Try again.", analysis: body.analysis ?? null });
    if (code === "amount_required" || code === "amount_invalid") amountRef.current?.focus();
  };

  if (!open) {
    return (
      <button disabled={full} onClick={() => setOpen(true)}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 text-sm font-semibold text-resq-navy disabled:opacity-50">
        <Icon.Plus size={18} />{full ? `Receipt limit reached (${max})` : "Bought parts for this job?"}
      </button>
    );
  }

  return (
    <div className="animate-slide-up space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-display font-bold text-resq-navy">Add a receipt</h4>
          <p className="text-xs text-resq-slate">Photograph the bill. The AI reads it, the customer approves it, and it is added to your payout in full.</p>
        </div>
        <button onClick={reset} aria-label="Close" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-resq-slate hover:bg-slate-100"><Icon.X size={16} /></button>
      </div>

      <label className={`flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl text-sm font-semibold ${file ? "border border-slate-200 text-resq-navy" : "bg-resq-navy text-white"}`}>
        <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Photograph the receipt" disabled={sending}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
        <Icon.Check size={16} className={file ? "" : "hidden"} />{file ? "Retake photo" : "Photograph the receipt"}
      </label>

      {preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="The receipt you just photographed" className="h-40 w-full rounded-xl border border-slate-200 bg-slate-100 object-contain" />
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-resq-slate">
          Amount (optional — the AI usually reads it)
          <input ref={amountRef} value={rupees} onChange={(e) => setRupees(e.target.value)} inputMode="decimal" maxLength={10} placeholder="e.g. 450"
            disabled={sending} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 px-3 font-mono text-base text-resq-navy" />
        </label>
        <label className="block text-xs font-semibold text-resq-slate">
          What you bought (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder="e.g. 1/2 inch tap + teflon tape"
            disabled={sending} className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 px-3 text-sm text-resq-navy" />
        </label>
      </div>

      {sending && (
        <div className="flex items-center gap-3 rounded-xl bg-resq-cyan-light p-3">
          <div className="flex shrink-0 gap-1.5">
            <span className="typing-dot-1 h-2 w-2 rounded-full bg-resq-cyan" /><span className="typing-dot-2 h-2 w-2 rounded-full bg-resq-cyan" /><span className="typing-dot-3 h-2 w-2 rounded-full bg-resq-cyan" />
          </div>
          <p className="text-xs text-resq-navy">Reading the receipt… {elapsed}s<br /><span className="text-resq-slate">A vision model on this laptop takes 10–40 seconds.</span></p>
        </div>
      )}

      {failed && (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">{failed.text}</p>
          {failed.analysis && <ReceiptReading a={failed.analysis} />}
        </div>
      )}

      <button disabled={!file || sending} onClick={send}
        className="min-h-14 w-full rounded-2xl bg-resq-navy font-display text-base font-bold text-white disabled:opacity-50">
        {sending ? "Reading…" : failed ? "Send again" : "Send to the customer"}
      </button>
      <p className="text-center text-xs text-resq-slate">{filed} of {max} receipts filed on this job.</p>
    </div>
  );
}
