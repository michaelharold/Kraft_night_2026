"use client";
/* Live view of one help request (the requester's side): triage, curated guidance, dispatch, match, tracking, rating. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Call112Bar, Container, Countdown, ETABadge, NavBar, ProgressBar, PulsingDot, TypingDots, initials } from "@/components/ui";
import { SKILL_META, SkillPill, URGENCY_STYLE } from "@/components/skills";
import { EquipmentPill } from "@/components/equipment";
import { LiveMap, type MapMarker } from "@/components/LiveMap";
import { HazardBanner } from "@/components/HazardBanner";
import { FallbackModal } from "@/components/FallbackModal";
import { TrustBadge } from "@/components/TrustBadge";
import { api, etaMinutes, fmtDistance, fmtTime, getHelperToken, getUid, type LatLng } from "@/lib/client/api";
import { useSecondsLeft, useSnapshot } from "@/lib/client/sse";
import { TYPE_LABELS } from "@/lib/taxonomy";
import { GIG_TYPES, categoryOf, feeOf, formatMoney } from "@/lib/policy";
import type { RequestView, RequesterRole } from "@/lib/types";

// `fallbackMs` comes from GET /api/config (upgrade §6); optional so older callers keep compiling.
type Config = { waveWindowMs: number; seedCenter?: LatLng; fallbackMs?: number };
const DEFAULT_FALLBACK_MS = 180_000;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const spanWords = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`);

export function Triaging({ text }: { text: string }) {
  return (
    <>
      <div className="bg-ai-gradient px-5 pb-5 pt-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/20"><Icon.Activity size={20} className="text-white" /></div>
          <div><p className="text-sm font-semibold text-white">Sahaya AI · on-device</p><p className="text-xs text-white/75">Understanding your emergency…</p></div>
        </div>
      </div>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-5">
        {text && <div className="flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-resq-navy px-4 py-3 text-sm text-white">{text}</div></div>}
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-ai-gradient"><Icon.Activity size={14} className="text-white" /></div>
          <div className="card-shadow rounded-2xl rounded-tl-sm border border-slate-100 bg-white px-5 py-4"><TypingDots /></div>
        </div>
      </main>
      <Call112Bar />
    </>
  );
}

// ─── Live request ──────────────────────────────────────────────────────────────────────────────────────────

export function RequestScreen({ id, config, onClose, onRetry }: { id: string; config: Config | null; onClose: () => void; onRetry: (id: string) => void }) {
  const uid = typeof window === "undefined" ? "" : getUid();
  const tok = typeof window === "undefined" ? "none" : getHelperToken() ?? "none";
  const { data, connected, setData } = useSnapshot<RequestView>(`/api/requests/${id}/stream?uid=${encodeURIComponent(uid)}&s=${encodeURIComponent(tok)}`, `/api/requests/${id}`, { "x-resq-uid": uid, "x-resq-session": tok });
  // After "Try again" the id changes before the new snapshot arrives: never show the previous request under the new id.
  const view = data && data.request.id === id ? data : null;
  const left = useSecondsLeft(view?.waveEndsAt);
  const ticking = useRef(0);
  const [notFound, setNotFound] = useState(false);

  // 3-minute smart fallback (LIFE_SAFETY only): deadline = createdAt + fallbackMs while the request is still searching.
  const fallbackMs = config?.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const fallbackDeadline = view && categoryOf(view.request) === "LIFE_SAFETY" && view.request.status === "searching"
    ? new Date(Date.parse(view.request.createdAt) + fallbackMs).toISOString() : null;
  const fallbackLeft = useSecondsLeft(fallbackDeadline);

  const tick = useCallback(async (force = false) => {
    if (!force && Date.now() - ticking.current < 2000) return;
    ticking.current = Date.now();
    const r = await api<RequestView & { advanced: boolean }>(`/api/requests/${id}/tick`, { method: "POST", headers: { "x-resq-uid": getUid() } });
    if (r.ok) setData(r.data);
    else if (r.status === 404 || r.status === 403) setNotFound(true);
  }, [id, setData]);

  useEffect(() => { void tick(); }, [tick]);
  useEffect(() => { if (view?.request.status === "searching" && view.waveEndsAt && left === 0) void tick(); }, [left, view, tick]);
  // One tick exactly at the fallback deadline so the server escalates on time even mid-wave, then every 2 s until it
  // does (covers a small clock difference between this device and the server). Cleared as soon as status changes.
  useEffect(() => {
    if (!fallbackDeadline) return;
    let again: ReturnType<typeof setInterval> | null = null;
    const at = setTimeout(() => {
      void tick(true);
      again = setInterval(() => void tick(true), 2000);
    }, Math.max(0, Date.parse(fallbackDeadline) - Date.now()));
    return () => { clearTimeout(at); if (again) clearInterval(again); };
  }, [fallbackDeadline, tick]);

  const patch = async (body: Record<string, unknown>) => {
    const r = await api<RequestView>(`/api/requests/${id}`, { method: "PATCH", body, headers: { "x-resq-uid": getUid() } });
    if (r.ok) setData(r.data);
  };
  const retry = async () => {
    if (!view) return;
    const old = view.request;
    const paid = categoryOf(old) === "HOUSEHOLD_MICROGIG";
    const body = { description: old.description, location: old.location, role: old.role, ...(paid ? { category: "HOUSEHOLD_MICROGIG", gigType: old.gigType, calloutFee: feeOf(old) } : {}) };
    const r = await api<RequestView>("/api/requests", { body, headers: { "x-resq-uid": getUid() } });
    if (!r.ok) return;
    // A paid job that is retried must not keep two fees in escrow: cancelling the old request refunds it.
    if (paid) await api(`/api/requests/${old.id}`, { method: "PATCH", body: { action: "cancel" }, headers: { "x-resq-uid": getUid() } });
    onRetry(r.data.request.id);
  };

  if (notFound) return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-resq-navy">This request is no longer available.</p>
      <button onClick={onClose} className="min-h-12 rounded-xl bg-resq-navy px-6 font-semibold text-white">Back to home</button>
    </main>
  );
  if (!view) return <Triaging text="" />;

  const r = view.request;
  const t = r.triage;
  const windowS = Math.round((config?.waveWindowMs ?? 30000) / 1000);
  const gig = categoryOf(r) === "HOUSEHOLD_MICROGIG";
  const hazard = t?.hazardAlert?.hasHazard ? t.hazardAlert : null;
  const header = gig ? {
    triaging: { bg: "bg-ai-gradient", title: "Understanding your request", sub: "Sahaya AI is checking the job for hidden hazards" },
    searching: { bg: "bg-navy-gradient", title: "Finding a Certified Pro", sub: `Wave ${r.wave} of 4 · pinging Certified Pros within ${r.radiusKm} km` },
    matched: { bg: "bg-success-gradient", title: "A pro is on the way", sub: view.matchedHelper ? `${view.matchedHelper.name} accepted your job` : "A Certified Pro accepted" },
    resolved: { bg: "bg-success-gradient", title: "Job done", sub: "The callout fee was released to your helper" },
    escalated: { bg: "bg-navy-gradient", title: "No pro available right now", sub: "No Certified Pro nearby accepted this job." },
    cancelled: { bg: "bg-navy-gradient", title: "Request cancelled", sub: "Helpers have been stood down" },
  }[r.status] : {
    triaging: { bg: "bg-ai-gradient", title: "Understanding your emergency", sub: "Sahaya AI is classifying your request" },
    searching: { bg: "bg-navy-gradient", title: "Finding help", sub: `Wave ${r.wave} of 4 · pinging the best helpers within ${r.radiusKm} km` },
    matched: { bg: "bg-success-gradient", title: "Help is on the way", sub: view.matchedHelper ? `${view.matchedHelper.name} accepted your request` : "A helper accepted" },
    resolved: { bg: "bg-success-gradient", title: "Marked as resolved", sub: "We hope everyone is safe" },
    escalated: { bg: "bg-emergency-gradient", title: "Call 112 now", sub: "No neighbour could be reached. A coordinator has been alerted." },
    cancelled: { bg: "bg-navy-gradient", title: "Request cancelled", sub: "Helpers have been stood down" },
  }[r.status];

  return (
    <>
      <div className={header.bg}>
        <Container><NavBar title="Your request" onBack={onClose} light action={
          <span className="flex items-center gap-1.5 rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white">
            <PulsingDot color={connected ? "green" : "red"} />{connected ? "LIVE" : "…"}
          </span>} /></Container>
        <div className="px-5 pb-6 text-center">
          {r.status === "matched" && <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-white/20"><Icon.Check size={34} className="text-white" /></div>}
          <h2 className="font-display text-2xl font-bold text-white">{header.title}</h2>
          <p className="mt-1 text-sm text-white/80">{header.sub}</p>
          <p className="mt-2.5 flex justify-center">
            {gig
              ? <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white"><Icon.Shield size={12} />Paid household job · {formatMoney(feeOf(r))} callout</span>
              : <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white"><Icon.Heart size={12} />FREE · life-safety request</span>}
          </p>
        </div>
      </div>

      <main className="relative z-10 mx-auto -mt-3 grid w-full max-w-6xl flex-1 content-start gap-4 px-4 pb-6 md:px-8 lg:grid-cols-2 lg:items-start">
        {hazard && <HazardBanner alert={hazard} className="lg:col-span-2" />}
        <div className="flex flex-col gap-4">
        {r.upgradedToLifeSafety && (
          <div role="status" className="card-shadow flex items-start gap-3 rounded-2xl border border-resq-green/30 bg-resq-green-light p-4">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-resq-green text-white"><Icon.Check size={18} /></div>
            <p className="text-sm font-semibold text-green-900">This looked like an emergency, so it is FREE and we alerted everyone nearby.</p>
          </div>
        )}
        {r.status === "escalated" && gig && (
          <div className="card-shadow-lg rounded-2xl border-2 border-resq-amber bg-white p-5 text-center">
            <p className="font-display text-lg font-bold text-resq-navy">No Certified Pro accepted this job.</p>
            <p className="mt-1 text-sm text-resq-slate">{r.location ? "We tried 4 waves up to 8 km." : "We could not get your location."} Try again, or cancel the request and your callout fee is refunded.</p>
            <button onClick={retry} className="mt-4 min-h-12 w-full rounded-2xl bg-resq-navy font-semibold text-white">Try again</button>
          </div>
        )}
        {r.status === "escalated" && !gig && (
          <div className="card-shadow-lg rounded-2xl border-2 border-resq-red bg-white p-5 text-center">
            <p className="font-display text-lg font-bold text-resq-red">No helper could be reached.</p>
            <p className="mt-1 text-sm text-resq-slate">{r.location ? "We tried 4 waves up to 8 km." : "We could not get your location."} Please call emergency services.</p>
            <a href="tel:112" className="mt-4 flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-resq-red font-display text-lg font-bold text-white"><Icon.Phone size={20} />Call 112</a>
            <button onClick={retry} className="mt-3 min-h-12 w-full rounded-2xl border border-slate-200 font-semibold text-resq-navy">Try again</button>
          </div>
        )}

        {r.status === "searching" && <DispatchCard view={view} left={left} windowS={windowS} fallbackLeft={fallbackDeadline ? fallbackLeft : null} fallbackMs={fallbackMs} />}
        {(r.status === "matched" || r.status === "resolved") && view.matchedHelper && <MatchedCard view={view} />}
        {r.status === "resolved" && <RateCard onRate={(stars) => patch({ action: "rate", stars })} />}
        {gig && <FeeCard view={view} />}
        {t && <TriageCard view={view} />}
        </div>
        <div className="flex flex-col gap-4">
        {/* A paid household job needs no first-aid card, unless the scene is dangerous. */}
        {view.guidance && (!gig || hazard) && <GuidanceCard view={view} />}
        <Timeline view={view} />

        {(r.status === "searching" || r.status === "matched" || r.status === "escalated") && (
          <button onClick={() => { if (confirm("Cancel this request? Helpers will be stood down.")) void patch({ action: "cancel" }); }}
            className="min-h-12 w-full rounded-2xl border border-slate-200 bg-slate-100 text-sm font-semibold text-resq-slate">Cancel request</button>
        )}
        {(r.status === "resolved" || r.status === "cancelled") && (
          <button onClick={onClose} className="min-h-12 w-full rounded-2xl bg-resq-navy font-semibold text-white">Back to home</button>
        )}
        </div>
      </main>
      <Call112Bar />
      <FallbackModal key={r.id} request={r} onRetry={retry} />
    </>
  );
}

function DispatchCard({ view, left, windowS, fallbackLeft, fallbackMs }: { view: RequestView; left: number; windowS: number; fallbackLeft: number | null; fallbackMs: number }) {
  const r = view.request;
  const gig = categoryOf(r) === "HOUSEHOLD_MICROGIG";
  const current = view.dispatches.filter((d) => d.wave === r.wave);
  const earlier = view.dispatches.filter((d) => d.wave < r.wave).length;
  const statusText = (s: string) => ({ pinged: "● Notified", rejected: "✕ Declined", expired: "○ No answer", cancelled: "○ Stood down", accepted: "✓ Accepted" }[s] ?? s);
  const statusColor = (s: string) => (s === "pinged" ? "#0EA5E9" : s === "accepted" ? "#16A34A" : "#94A3B8");
  return (
    <section className="card-shadow-lg animate-slide-up rounded-3xl border border-slate-100 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="font-display text-sm font-bold text-resq-navy">{current.length} helpers pinged at once</p>
          <p className="text-xs text-resq-slate">{gig ? "Only Certified Pros are pinged for paid jobs · first" : "First"} to accept gets the job{earlier ? ` · ${earlier} tried earlier` : ""}</p>
        </div>
        <Countdown seconds={left} total={windowS} />
      </div>
      <div className="space-y-2.5">
        {current.map((d, i) => (
          <div key={d.id} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: d.helperSkills[0] ? SKILL_META[d.helperSkills[0]].color : "#64748B" }}>
              {d.helperSkills[0] ? SKILL_META[d.helperSkills[0]].icon : <Icon.User size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-sm font-semibold text-resq-navy">Helper {i + 1} · {fmtDistance(d.distanceKm)}</p>
                <TrustBadge tier={d.helperTier ?? "TIER_1_NEIGHBOR"} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1">{d.helperSkills.slice(0, 3).map((s) => <SkillPill key={s} skill={s} />)}</div>
            </div>
            <span className="text-xs font-semibold" style={{ color: statusColor(d.status) }}>{statusText(d.status)}</span>
          </div>
        ))}
        {current.length === 0 && <p className="text-sm text-resq-slate">Widening the search…</p>}
      </div>
      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-resq-slate">Response window</span><span className="font-mono font-bold text-resq-navy">{left}s</span></div>
        <ProgressBar seconds={left} total={windowS} />
        <p className="mt-1.5 text-xs text-resq-slate">No answer? The search widens automatically: 1 → 2 → 4 → 8 km.</p>
        {fallbackLeft !== null && (
          <div role="timer" aria-label={`Auto-escalates in ${mmss(fallbackLeft)}`} className="mt-3 flex items-start gap-2.5 rounded-xl bg-resq-red-light px-3 py-2.5">
            <Icon.Clock size={16} className="mt-0.5 flex-shrink-0 text-resq-red" />
            <p className="text-xs text-resq-red-dark">
              <span className="font-bold">{fallbackLeft > 0 ? <>Auto-escalates in <span className="font-mono">{mmss(fallbackLeft)}</span></> : "Escalating now…"}</span>
              {" "}· if nobody accepts within {spanWords(fallbackMs)} we tell you to call 112 and text your emergency contact.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function MatchedCard({ view }: { view: RequestView }) {
  const h = view.matchedHelper!;
  const r = view.request;
  const eta = etaMinutes(h.distanceKm);
  const arrived = h.distanceKm !== null && h.distanceKm < 0.05;
  const markers: MapMarker[] = [];
  if (r.location) markers.push({ id: "you", at: r.location, color: "#DC2626", kind: "you", label: "You" });
  if (h.location) markers.push({ id: "helper", at: h.location, color: "#16A34A", kind: "target", label: h.name.split(" ")[0].slice(0, 7) });
  const radius = Math.max(0.4, (h.distanceKm ?? 0.5) * 1.4);
  return (
    <section className="animate-slide-up space-y-4">
      <div className="card-shadow-lg rounded-2xl border border-slate-100 bg-white p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-resq-red to-resq-navy text-xl font-bold text-white shadow-lg">{initials(h.name)}</div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg font-bold text-resq-navy">{h.name}</h3>
              <span className="flex items-center gap-0.5 rounded-lg bg-amber-50 px-2 py-0.5"><Icon.Star size={11} className="text-amber-400" /><span className="text-xs font-bold text-amber-700">{(h.reliability * 5).toFixed(1)}</span></span>
            </div>
            <div className="mt-1"><TrustBadge tier={h.trustTier ?? "TIER_1_NEIGHBOR"} /></div>
            <div className="mt-1.5 flex flex-wrap gap-1">{h.skills.map((s) => <SkillPill key={s} skill={s} />)}{(h.equipment ?? []).map((e) => <EquipmentPill key={e} item={e} />)}</div>
          </div>
        </div>
        {view.request.status === "matched" && (
          <div className="mt-4 flex items-center justify-center gap-3">
            {arrived ? <Badge variant="success">Arrived at your location</Badge> : <>
              <ETABadge minutes={eta} />
              <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-1.5 text-resq-navy"><Icon.MapPin size={14} /><span className="text-sm font-medium">{fmtDistance(h.distanceKm)} away</span></div>
            </>}
          </div>
        )}
      </div>
      {view.request.status === "matched" && r.location && (
        <div className="card-shadow relative overflow-hidden rounded-2xl">
          <LiveMap center={r.location} radiusKm={radius} markers={markers} height={180} route={h.location ? [h.location, r.location] : undefined} />
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-xl border border-slate-100 bg-white px-3 py-1.5 shadow">
            <Icon.Navigation size={14} className="text-resq-green" /><span className="text-xs font-bold text-resq-navy">{arrived ? "Arrived" : `Live · ${fmtDistance(h.distanceKm)} · ~${eta} min`}</span>
          </div>
        </div>
      )}
      {view.request.status === "matched" && (
        <div className="grid grid-cols-2 gap-3">
          <a href={`tel:${h.phone}`} className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-resq-navy text-sm font-semibold text-white shadow-lg"><Icon.Phone size={18} />Call {h.name.split(" ")[0]}</a>
          <a href={`sms:${h.phone}`} className="card-shadow flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-resq-navy"><Icon.MessageSquare size={18} />Message</a>
        </div>
      )}
    </section>
  );
}

/** Callout fee + escrow state in words (paid household jobs only). Demo escrow: in-memory wallet, no real payment rails. */
function FeeCard({ view }: { view: RequestView }) {
  const r = view.request;
  const state = r.escrowStatus ?? null;
  const who = view.matchedHelper?.name ?? "your helper";
  const words = state === "HELD" ? "Held in escrow until the job is marked done" : state === "RELEASED" ? `Released to ${who}` : state === "REFUNDED" ? "Refunded to you" : null;
  const tone = state === "RELEASED" ? { chip: "bg-resq-green-light text-resq-green", box: "bg-resq-green-light text-green-900" }
    : state === "REFUNDED" ? { chip: "bg-slate-100 text-resq-navy", box: "bg-slate-100 text-resq-navy" }
    : { chip: "bg-amber-50 text-amber-800", box: "bg-amber-50 text-amber-900" };
  return (
    <section aria-label="Callout fee" className="card-shadow rounded-2xl border border-slate-100 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-resq-slate">Callout fee</p>
          <p className="mt-0.5 font-display text-3xl font-bold text-resq-navy">{formatMoney(feeOf(r))}</p>
          <p className="mt-0.5 text-sm text-resq-slate">{r.gigType ? GIG_TYPES[r.gigType].label : "Household job"} · paid household job</p>
        </div>
        {state && <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tone.chip}`}>{state}</span>}
      </div>
      {words && (
        <p className={`mt-3 flex items-start gap-2 rounded-xl p-3 text-sm font-medium ${tone.box}`}>
          {state === "RELEASED" ? <Icon.Check size={16} className="mt-0.5 flex-shrink-0" /> : <Icon.Shield size={16} className="mt-0.5 flex-shrink-0" />}<span>{words}</span>
        </p>
      )}
      <p className="mt-2 text-xs text-resq-slate">Only a Certified Pro can accept a paid job. Demo wallet: no real payment is taken.</p>
    </section>
  );
}

function RateCard({ onRate }: { onRate: (stars: number) => void }) {
  const [stars, setStars] = useState(0);
  return (
    <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-5 text-center">
      <p className="font-display font-semibold text-resq-navy">{stars ? "Thank you for rating" : "How did your helper do?"}</p>
      <div className="mt-3 flex justify-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} aria-label={`${n} stars`} disabled={stars > 0} onClick={() => { setStars(n); onRate(n); }}
            className={`flex h-12 w-12 items-center justify-center rounded-xl ${n <= stars ? "text-amber-400" : "text-slate-300"}`}>
            <Icon.Star size={28} />
          </button>
        ))}
      </div>
    </section>
  );
}

function TriageCard({ view }: { view: RequestView }) {
  const t = view.request.triage!;
  const r = view.request;
  // A paid household job is shown by its gig type ("Plumbing job"), not as an "Other emergency".
  const title = categoryOf(r) === "HOUSEHOLD_MICROGIG" && r.gigType ? `${GIG_TYPES[r.gigType].label} job` : TYPE_LABELS[t.type];
  return (
    <section className="card-shadow overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="flex items-center gap-2 bg-ai-gradient px-4 py-2.5">
        <Icon.Activity size={16} className="text-white" />
        <p className="text-sm font-semibold text-white">Sahaya AI triage</p>
        <span className="ml-auto rounded-lg bg-white/20 px-2 py-0.5 text-xs font-semibold text-white">{t.source === "ollama" ? "Local AI" : "Keyword rules"}</span>
      </div>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-display text-lg font-bold text-resq-navy">{title}</p>
          <span className={`rounded-lg px-2 py-0.5 text-xs font-bold uppercase ${URGENCY_STYLE[t.urgency]}`}>{t.urgency}</span>
        </div>
        <p className="mt-1 text-sm text-resq-slate">{t.summary}</p>
        <p className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wider text-resq-slate">Skills we are looking for</p>
        <div className="flex flex-wrap gap-1.5">{t.skills.map((s) => <SkillPill key={s} skill={s} />)}</div>
        {(t.equipment ?? []).length > 0 && (
          <>
            <p className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wider text-resq-slate">Equipment we are looking for</p>
            <div className="flex flex-wrap gap-1.5">{(t.equipment ?? []).map((e) => <EquipmentPill key={e} item={e} />)}</div>
          </>
        )}
        {t.clarifyingQuestion && (
          <p className="mt-3 rounded-xl bg-resq-cyan-light p-3 text-sm text-resq-navy"><strong>Tell the helper:</strong> {t.clarifyingQuestion}</p>
        )}
      </div>
    </section>
  );
}

function GuidanceCard({ view }: { view: RequestView }) {
  const g = view.guidance!;
  const [role, setRole] = useState<RequesterRole>(view.request.role ?? "other");
  const steps = role === "self" ? g.selfSteps : g.steps;
  return (
    <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display font-bold text-resq-navy">What to do now</h3>
        <div className="flex rounded-xl bg-slate-100 p-0.5" role="group" aria-label="Who needs help">
          {([["self", "It's me"], ["other", "Someone else"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setRole(v)} aria-pressed={role === v}
              className={`min-h-10 rounded-lg px-3 text-xs font-semibold ${role === v ? "bg-white text-resq-navy shadow" : "text-resq-slate"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="mb-2 text-sm font-semibold text-resq-red">{g.title}</p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm text-resq-navy">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-resq-navy text-xs font-bold text-white">{i + 1}</span>
            <span className="pt-0.5">{s}</span>
          </li>
        ))}
      </ol>
      {g.doNot.length > 0 && (
        <div className="mt-3 rounded-xl bg-amber-50 p-3">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-800">Do not</p>
          <ul className="list-disc space-y-0.5 pl-4 text-sm text-amber-900">{g.doNot.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      <div className="mt-3 rounded-xl bg-resq-red-light p-3">
        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-resq-red">Call 112 if</p>
        <ul className="list-disc space-y-0.5 pl-4 text-sm text-resq-red-dark">{g.call112When.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
      <p className="mt-3 text-xs text-resq-slate">Curated guidance ({g.source}). Not written by AI. Not a substitute for 112.</p>
    </section>
  );
}

function Timeline({ view }: { view: RequestView }) {
  const r = view.request;
  const waves = [...new Set(view.dispatches.map((d) => d.wave))];
  const acc = view.dispatches.find((d) => d.status === "accepted");
  const gig = categoryOf(r) === "HOUSEHOLD_MICROGIG";
  const ev: { label: string; detail?: string; time?: string; state: "done" | "active" | "pending" }[] = [
    { label: gig ? "Job requested" : "Emergency reported", detail: r.channel === "sms" ? "By SMS" : "In the app", time: fmtTime(r.createdAt), state: "done" },
    { label: "AI identified the help needed", detail: r.triage ? `${TYPE_LABELS[r.triage.type]} · ${r.triage.skills.map((s) => SKILL_META[s].label).join(", ")}` : undefined, state: r.triage ? "done" : "active" },
    ...(r.triage?.hazardAlert?.hasHazard ? [{ label: "Hazard warning shown", detail: r.triage.hazardAlert.hazardTitle ?? undefined, state: "done" as const }] : []),
    ...(r.upgradedToLifeSafety ? [{ label: "Upgraded to a free emergency", detail: "No fee · everyone nearby alerted", state: "done" as const }] : []),
    ...(gig ? [{ label: `Callout fee ${formatMoney(feeOf(r))} held in escrow`, detail: "Only Certified Pros are pinged", state: "done" as const }] : []),
    ...waves.map((w) => ({ label: `Wave ${w}: ${view.dispatches.filter((d) => d.wave === w).length} helpers pinged`, detail: `Within ${[1, 2, 4, 8][w - 1]} km`, time: fmtTime(view.dispatches.find((d) => d.wave === w)?.pingedAt), state: (r.status === "searching" && w === r.wave ? "active" : "done") as "done" | "active" })),
  ];
  if (acc || r.status === "matched" || r.status === "resolved") ev.push({ label: `${view.matchedHelper?.name ?? "Helper"} accepted`, time: fmtTime(acc?.pingedAt), state: "done" });
  if (r.status === "matched") ev.push({ label: "En route", detail: `About ${etaMinutes(view.matchedHelper?.distanceKm)} min away`, state: "active" });
  if (r.status === "resolved") ev.push({ label: "Help delivered", time: fmtTime(r.updatedAt), state: "done" });
  if (gig && r.escrowStatus === "RELEASED") ev.push({ label: `${formatMoney(feeOf(r))} released to ${view.matchedHelper?.name ?? "the helper"}`, detail: "Escrow paid out to their wallet", state: "done" });
  if (r.status === "escalated") ev.push({ label: gig ? "No Certified Pro accepted" : "Escalated to coordinator", detail: gig ? undefined : "Call 112", time: fmtTime(r.fallbackAt ?? r.updatedAt), state: "active" });
  if (r.emergencyContactNotifiedAt) ev.push({ label: "Emergency contact texted", detail: r.requesterProfile?.emergencyContactName ?? undefined, time: fmtTime(r.emergencyContactNotifiedAt), state: "done" });
  if (r.status === "cancelled") ev.push({ label: "Cancelled", time: fmtTime(r.updatedAt), state: "done" });
  if (gig && r.escrowStatus === "REFUNDED") ev.push({ label: "Callout fee refunded", state: "done" });
  return (
    <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-4">
      <h3 className="mb-4 font-display font-semibold text-resq-navy">Timeline</h3>
      <div className="relative">
        <div className="timeline-line" style={{ top: 12, bottom: 12 }} />
        <ol className="space-y-4">
          {ev.map((e, i) => (
            <li key={i} className="relative flex gap-4">
              <div className={`z-10 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 ${e.state === "done" ? "border-resq-green bg-resq-green" : e.state === "active" ? "animate-dispatch-pulse border-resq-red bg-resq-red" : "border-slate-300 bg-white"}`}>
                {e.state === "done" && <Icon.Check size={12} className="text-white" />}
                {e.state === "active" && <div className="h-2 w-2 rounded-full bg-white" />}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-sm font-semibold text-resq-navy">{e.label}</p>
                  {e.time && <span className="font-mono text-xs text-resq-slate">{e.time}</span>}
                </div>
                {e.detail && <p className="mt-0.5 text-xs text-resq-slate">{e.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

