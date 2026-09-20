"use client";
/*
 * AI preview before a request is broadcast. The local model (Ollama) has scoped the job: title, time, skill level,
 * tools, steps. The customer adds the photos it asked for (each with the angle to shoot from) and answers its short
 * questions; those go ONLY to the worker who accepts, so they arrive with the right parts. Then "Confirm & send".
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { SKILL_META } from "./skills";
import { fmtRate } from "./ServiceRequestView";
import { api, fmtDistance, getHelperToken, type LatLng } from "@/lib/client/api";
import { TOOL_LABELS, type Service } from "@/lib/taxonomy";
import type { JobPhoto, RateRange, RequestView, TaskScope } from "@/lib/types";

type Preview = {
  jobId: string; scope: TaskScope;
  match: { count: number; online: number; offline: number; toolMatch: "all" | "any" | "skills_only" | "none";
    top: { name: string; distanceKm: number; rate: RateRange | null; online: boolean; toolsMatched: number; toolsNeeded: number }[] };
};

export function TaskScopeModal({ service, description, location, onClose, onSent, onSendWithoutAI }: {
  service: Service; description: string; location: LatLng | null;
  onClose: () => void; onSent: (requestId: string) => void; onSendWithoutAI: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);
  const [photos, setPhotos] = useState<Record<number, JobPhoto | "uploading" | "failed">>({});
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode double-mount: scope once
    started.current = true;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    void api<Preview>("/api/scope-task", { body: { action: "preview", service, rawDescription: description, location } }).then((r) => {
      clearInterval(t);
      if (r.ok) setPreview(r.data); else setError({ code: r.error, detail: typeof r.data.detail === "string" ? r.data.detail : undefined });
    });
    return () => clearInterval(t);
  }, [service, description, location]);

  const upload = async (i: number, file: File) => {
    if (!preview) return;
    const req = preview.scope.photoRequests[i];
    setPhotos((p) => ({ ...p, [i]: "uploading" }));
    const fd = new FormData();
    fd.append("file", file); fd.append("label", req.what); fd.append("angle", req.angle);
    const res = await fetch(`/api/jobs/${preview.jobId}/photos`, { method: "POST", body: fd, headers: { "x-resq-session": getHelperToken() ?? "none" } });
    const body = (await res.json().catch(() => ({}))) as { photo?: JobPhoto };
    setPhotos((p) => ({ ...p, [i]: res.ok && body.photo ? body.photo : "failed" }));
  };

  const confirm = async () => {
    if (!preview) return;
    setSending(true);
    const list = preview.scope.questions.map((q, i) => ({ question: q, answer: (answers[i] ?? "").trim() })).filter((a) => a.answer);
    const r = await api<{ request: RequestView }>("/api/scope-task", { body: { action: "confirm", jobId: preview.jobId, answers: list } });
    setSending(false);
    if (r.ok) onSent(r.data.request.request.id); else setError({ code: r.error });
  };

  const m = SKILL_META[service];
  const s = preview?.scope;
  const busyUploading = Object.values(photos).includes("uploading");
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-resq-navy-dark/60 backdrop-blur-sm md:items-center" role="dialog" aria-modal="true" aria-labelledby="scope-title">
      <div className="animate-slide-up flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-slate-50 shadow-2xl md:rounded-3xl">
        <div className="flex items-start justify-between gap-3 bg-ai-gradient px-5 py-4 text-white">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/75"><Icon.Activity size={14} />AI job analysis · runs on this device</p>
            <h2 id="scope-title" className="mt-1 font-display text-xl font-bold">{s ? s.parsedTitle : "Understanding your job…"}</h2>
            {s && <p className="text-xs text-white/75">Analysed by {s.model}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/15"><Icon.X size={18} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!preview && !error && (
            <div className="py-10 text-center">
              <div className="mx-auto flex w-fit gap-1.5"><span className="typing-dot-1 h-2.5 w-2.5 rounded-full bg-resq-cyan" /><span className="typing-dot-2 h-2.5 w-2.5 rounded-full bg-resq-cyan" /><span className="typing-dot-3 h-2.5 w-2.5 rounded-full bg-resq-cyan" /></div>
              <p className="mt-3 text-sm text-resq-slate">Working out the tools, time and photos a {m.label.toLowerCase()} will need… {elapsed}s</p>
              <p className="mt-1 text-xs text-resq-slate">The local model can take 10–40 seconds on a laptop.</p>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
              <p className="font-display font-bold text-amber-900">{error.code === "ai_unavailable" ? "The AI assistant isn't available right now" : error.code === "database_unavailable" ? "Couldn't save the job" : "Couldn't analyse this description"}</p>
              <p className="mt-1 text-sm text-amber-900/80">{error.code === "ai_unavailable" ? "Ollama isn't reachable on this server. You can still send the request; providers will see your description." : "You can still send the request without the AI breakdown."}</p>
              <button onClick={onSendWithoutAI} className="mt-3 min-h-12 w-full rounded-xl bg-resq-red font-semibold text-white">Send without AI analysis</button>
            </div>
          )}

          {s && preview && (
            <>
              <section className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-white p-3 card-shadow"><p className="font-mono text-lg font-bold text-resq-navy">~{s.estimatedTimeMinutes}m</p><p className="text-[11px] text-resq-slate">Est. time</p></div>
                <div className="rounded-2xl bg-white p-3 card-shadow"><p className="font-display text-lg font-bold capitalize text-resq-navy">{s.skillLevelRequired}</p><p className="text-[11px] text-resq-slate">Skill level</p></div>
                <div className="rounded-2xl bg-white p-3 card-shadow"><p className="font-mono text-lg font-bold text-resq-navy">{s.urgencyScore}/10</p><p className="text-[11px] text-resq-slate">Urgency</p></div>
              </section>

              <section className="rounded-2xl bg-white p-4 card-shadow">
                <h3 className="font-display font-semibold text-resq-navy">Tools the {m.label.toLowerCase()} should bring</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.requiredTools.length ? s.requiredTools.map((t) => <span key={t} className="rounded-lg bg-resq-cyan-light px-2.5 py-1 text-xs font-semibold text-resq-cyan">{TOOL_LABELS[t]}</span>)
                    : <span className="text-sm text-resq-slate">Standard kit</span>}
                </div>
                {s.steps.length > 0 && (
                  <ol className="mt-3 space-y-1 text-sm text-resq-navy">{s.steps.map((st, i) => <li key={i} className="flex gap-2"><span className="font-mono text-resq-slate">{i + 1}.</span>{st}</li>)}</ol>
                )}
              </section>

              <section className="rounded-2xl bg-white p-4 card-shadow">
                <h3 className="font-display font-semibold text-resq-navy">Help them come prepared: add these photos</h3>
                <p className="mb-3 text-xs text-resq-slate">Only the {m.label.toLowerCase()} who accepts your job will see them. Optional, but it saves a second trip.</p>
                <ul className="space-y-2">
                  {s.photoRequests.map((p, i) => {
                    const st = photos[i];
                    const done = st && st !== "uploading" && st !== "failed";
                    return (
                      <li key={i} className={`flex items-center gap-3 rounded-xl border p-3 ${done ? "border-resq-green bg-resq-green-light" : "border-slate-200"}`}>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-resq-navy">{i + 1}. {p.what}</p>
                          <p className="text-xs text-resq-slate"><strong>Angle:</strong> {p.angle}</p>
                          <p className="text-xs text-resq-slate">{p.why}</p>
                        </div>
                        <label className={`flex min-h-12 min-w-24 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold ${done ? "bg-resq-green text-white" : "bg-resq-navy text-white"}`}>
                          <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={`Photo: ${p.what}`}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i, f); }} />
                          {st === "uploading" ? "Uploading…" : done ? <><Icon.Check size={14} />Added</> : st === "failed" ? "Retry" : "Take photo"}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {s.questions.length > 0 && (
                <section className="rounded-2xl bg-white p-4 card-shadow">
                  <h3 className="font-display font-semibold text-resq-navy">Quick questions</h3>
                  <div className="mt-2 space-y-2">
                    {s.questions.map((q, i) => (
                      <label key={i} className="block text-sm text-resq-navy">{q}
                        <input value={answers[i] ?? ""} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} maxLength={200} placeholder="Your answer (optional)"
                          className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" />
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <section className="rounded-2xl bg-white p-4 card-shadow">
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-semibold text-resq-navy">Matched providers</h3>
                  <span className="rounded-full bg-resq-green-light px-2.5 py-0.5 text-xs font-bold text-resq-green">{preview.match.count} verified nearby</span>
                </div>
                <p className="mt-1 text-xs text-resq-slate">
                  {preview.match.count === 0 ? `No verified ${m.label.toLowerCase()} with these tools is available within 10 km right now. All ${m.label.toLowerCase()}s nearby will still see your request in their app.`
                    : `${preview.match.toolMatch === "all" ? "They carry every tool listed." : preview.match.toolMatch === "any" ? "They carry some of the tools listed." : "Matched on skills."} ${preview.match.online} in the app now, ${preview.match.offline} offline will get an SMS.`}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {preview.match.top.map((w, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2 text-resq-navy"><span className={`h-2 w-2 rounded-full ${w.online ? "bg-resq-green" : "bg-slate-300"}`} />{w.name}</span>
                      <span className="text-xs text-resq-slate">{fmtDistance(w.distanceKm)} · {w.toolsMatched}/{w.toolsNeeded} tools · {fmtRate(w.rate)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>

        {preview && (
          <div className="border-t border-slate-200 bg-white p-4">
            <button onClick={confirm} disabled={sending || busyUploading}
              className="min-h-14 w-full rounded-2xl bg-resq-red font-display text-lg font-bold text-white shadow-lg disabled:opacity-60">
              {sending ? "Sending…" : busyUploading ? "Waiting for photos…" : `Confirm & send${preview.match.count ? ` to ${preview.match.count} matched` : ""}`}
            </button>
            <p className="mt-2 text-center text-xs text-resq-slate">All nearby {m.label.toLowerCase()}s see it in the app; matched ones who are offline get an SMS they can accept with one reply.</p>
          </div>
        )}
      </div>
    </div>
  );
}
