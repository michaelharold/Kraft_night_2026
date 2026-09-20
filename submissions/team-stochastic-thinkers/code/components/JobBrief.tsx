"use client";
/* The AI job brief: tools, time, steps, the customer's photos (with the angle they were asked to shoot) and answers.
   Photos are fetched with the viewer's per-window session (?s=), which the photo route authorises. */
import { Icon } from "./icons";
import { getHelperToken } from "@/lib/client/api";
import { TOOL_LABELS } from "@/lib/taxonomy";
import type { HelpRequest, Tool } from "@/lib/types";

export function JobBrief({ r, toolsHave, title = "Come prepared" }: { r: HelpRequest; toolsHave?: Tool[]; title?: string }) {
  const s = r.scope;
  const photos = r.attachments ?? [];
  const answers = r.answers ?? [];
  if (!s && photos.length === 0 && answers.length === 0) return null;
  const tok = typeof window === "undefined" ? "" : encodeURIComponent(getHelperToken() ?? "none");
  return (
    <section className="rounded-2xl border border-resq-cyan/30 bg-resq-cyan-light/60 p-4">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-resq-cyan"><Icon.Activity size={14} />{title}</p>
      {s && (
        <>
          <p className="mt-1 font-display font-bold text-resq-navy">{s.parsedTitle}</p>
          <p className="text-xs text-resq-slate">~{s.estimatedTimeMinutes} min · {s.skillLevelRequired} · urgency {s.urgencyScore}/10</p>
          {s.requiredTools.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.requiredTools.map((t) => {
                const have = toolsHave ? toolsHave.includes(t) : undefined;
                return <span key={t} className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-semibold ${have === false ? "bg-amber-100 text-amber-800" : "bg-white text-resq-navy"}`}>
                  {have ? <Icon.Check size={12} className="text-resq-green" /> : null}{TOOL_LABELS[t]}{have === false ? " (you don't list this)" : ""}</span>;
              })}
            </div>
          )}
          {s.steps.length > 0 && <ol className="mt-2 space-y-0.5 text-sm text-resq-navy">{s.steps.map((st, i) => <li key={i}><span className="font-mono text-resq-slate">{i + 1}.</span> {st}</li>)}</ol>}
        </>
      )}
      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {photos.map((p) => (
            <a key={p.id} href={`/api/jobs/${r.id}/photos/${p.id}?s=${tok}`} target="_blank" rel="noopener noreferrer" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/jobs/${r.id}/photos/${p.id}?s=${tok}`} alt={`${p.label} (${p.angle})`} className="h-28 w-full object-cover" />
              <p className="px-2 py-1 text-[11px] leading-tight text-resq-navy"><strong>{p.label}</strong>{p.angle ? ` · ${p.angle}` : ""}</p>
            </a>
          ))}
        </div>
      )}
      {answers.length > 0 && (
        <dl className="mt-3 space-y-1 text-sm">
          {answers.map((a, i) => <div key={i}><dt className="text-xs text-resq-slate">{a.question}</dt><dd className="font-semibold text-resq-navy">{a.answer}</dd></div>)}
        </dl>
      )}
    </section>
  );
}
