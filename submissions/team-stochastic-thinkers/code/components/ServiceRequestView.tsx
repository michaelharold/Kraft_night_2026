"use client";
/*
 * The requester's live view of a service request: finding a provider → matched (details, map, call, message) →
 * done (bill, pay, rate).
 *
 * The money is deliberately not an afterthought bolted to the end. A receipt the provider files mid-job appears on
 * this screen the moment they file it, while they are still standing in the room, because approving a ₹450 tap is
 * a conversation the two of them can have face to face — and because a claim first seen on the final bill is a
 * claim the customer has no way to check. PaymentPanel owns all of it: the review cards, the itemised bill, the
 * Razorpay checkout and the receipt afterwards. This file only decides where on the page it sits.
 */
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { Badge, ETABadge, NavBar, PulsingDot, initials } from "./ui";
import { SKILL_META } from "./skills";
import { LiveMap, type MapMarker } from "./LiveMap";
import { JobBrief } from "./JobBrief";
import { PaymentPanel } from "./PaymentPanel";
import { VoiceNotes } from "./VoiceNotes";
import { languageOf, type LanguageCode } from "@/lib/languages";
import { api, etaMinutes, fmtDistance, fmtTime, getHelperToken, getUid } from "@/lib/client/api";
import { useSnapshot } from "@/lib/client/sse";
import type { RateRange, RequestView, Skill } from "@/lib/types";

export type ProviderPreview = { id: string; name: string; verified: boolean; rating: number; rate: RateRange | null; distanceKm: number };
export const fmtRate = (r: RateRange | null | undefined) => (r ? `₹${r.min.toLocaleString("en-IN")}–₹${r.max.toLocaleString("en-IN")}` : "Rate on request");

export function VerifiedBadge({ verified, pending = false }: { verified: boolean; pending?: boolean }) {
  if (verified) return <span className="inline-flex items-center gap-1 rounded-full bg-positive-soft px-2.5 py-1 text-xs font-bold text-positive"><Icon.Shield size={12} />ID verified</span>;
  if (pending) return <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2.5 py-1 text-xs font-bold text-warn"><Icon.Clock size={12} />ID under review</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-xs font-medium text-mist">Not verified</span>;
}

export function Stars({ rating }: { rating: number }) {
  return <span className="inline-flex items-center gap-0.5 rounded-full bg-warn-soft px-2 py-1 text-xs font-bold text-warn"><Icon.Star size={11} />{rating.toFixed(1)}</span>;
}

export function ServiceRequestView({ id, onClose }: { id: string; onClose: () => void }) {
  const [myLang, setMyLang] = useState<LanguageCode>(languageOf(null).code);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/me/language", { headers: { "x-resq-session": getHelperToken() ?? "none" } });
        if (res.ok) setMyLang(((await res.json()) as { language: LanguageCode }).language);
      } catch { /* the default language is a fine fallback */ }
    })();
  }, []);
  const uid = typeof window === "undefined" ? "" : getUid();
  const tok = typeof window === "undefined" ? "none" : getHelperToken() ?? "none";
  const { data: view, connected, setData } = useSnapshot<RequestView>(
    `/api/requests/${id}/stream?uid=${encodeURIComponent(uid)}&s=${encodeURIComponent(tok)}`, `/api/requests/${id}`, { "x-resq-uid": uid, "x-resq-session": tok });
  const [providers, setProviders] = useState<ProviderPreview[] | null>(null);
  const [stars, setStars] = useState(0);
  const r = view?.request;
  const service = (r?.service ?? null) as Skill | null;

  useEffect(() => {
    if (!service || !r?.location || r.status !== "searching") return;
    const load = () => api<{ providers: ProviderPreview[] }>(`/api/services?service=${service}&lat=${r.location!.lat}&lng=${r.location!.lng}`).then((x) => x.ok && setProviders(x.data.providers));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [service, r?.location, r?.status]);

  const patch = async (body: Record<string, unknown>) => {
    const x = await api<RequestView>(`/api/requests/${id}`, { method: "PATCH", body });
    if (x.ok) setData(x.data);
  };

  if (!view || !r || !service) return <div className="flex flex-1 items-center justify-center text-resq-slate">Loading…</div>;
  const meta = SKILL_META[service];
  const h = view.matchedHelper;
  /**
   * Every state uses the same bone header and says what it is in a chip.
   *
   * Two of these used to be a slab of dark green, which meant the header text had to be white — and white text
   * on the other four states (bone) was simply invisible. One background, one text colour, and the status lives
   * in a small coloured chip where it is legible in every state.
   */
  const header = {
    searching: { title: `Finding a ${meta.label.toLowerCase()}`, sub: "Nearby providers have your request. The first to accept gets the job.", chip: "Searching", tone: "bg-violet-soft text-violet-deep" },
    matched:   { title: `${h?.name ?? "Your provider"} is on the way`, sub: `${meta.label} · accepted at ${fmtTime(r.updatedAt)}`, chip: "On the way", tone: "bg-positive-soft text-positive" },
    resolved:  { title: "Job done", sub: "Thanks for using Sahaya", chip: "Completed", tone: "bg-positive-soft text-positive" },
    cancelled: { title: "Request cancelled", sub: "Providers have been told", chip: "Cancelled", tone: "bg-bone text-mist" },
    escalated: { title: "Still looking", sub: "No one has accepted yet", chip: "Still looking", tone: "bg-warn-soft text-warn" },
    triaging:  { title: "Sending…", sub: "", chip: "Sending", tone: "bg-bone text-mist" },
  }[r.status];

  const markers: MapMarker[] = [];
  if (r.location) markers.push({ id: "you", at: r.location, color: "#DC2626", kind: "you", label: "You" });
  if (h?.location) markers.push({ id: "pro", at: h.location, color: "#16A34A", kind: "target", label: h.name.split(" ")[0].slice(0, 8) });
  const arrived = h?.distanceKm != null && h.distanceKm < 0.05;

  return (
    <>
      <div className="bg-navy-gradient">
        <div className="mx-auto max-w-6xl">
          <NavBar title={meta.label} onBack={onClose} light action={
            <span className="card-shadow flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-ink"><PulsingDot color={connected ? "green" : "red"} />{connected ? "LIVE" : "…"}</span>} />
        </div>
        <div className="px-5 pb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white card-shadow" style={{ color: meta.color }}>{meta.icon}</div>
          <span className={`mb-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ${header.tone}`}>{header.chip}</span>
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-ink">{header.title}</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-mist">{header.sub}</p>
        </div>
      </div>

      <main className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-4 px-4 py-4 md:px-8 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-4">
          <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-4">
            <p className="text-xs font-bold text-mist">Your request</p>
            <p className="mt-1 text-sm text-resq-navy">“{r.description}”</p>
            <p className="mt-2 text-xs text-resq-slate">Sent {fmtTime(r.createdAt)}{r.location ? " · your location is shared with the provider who accepts" : ""}</p>
          </section>
          <JobBrief r={r} title="What the provider will see after accepting" />

          {r.status === "searching" && (
            <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-display font-semibold text-resq-navy">{meta.label}s near you</h3>
                <Badge variant={providers?.length ? "success" : "default"}>{providers?.length ?? 0} notified</Badge>
              </div>
              {providers === null && <p className="text-sm text-resq-slate">Loading…</p>}
              {providers?.length === 0 && <p className="text-sm text-resq-slate">No {meta.label.toLowerCase()} is available within 10 km right now. Your request stays open and appears as soon as one comes online.</p>}
              <ul className="space-y-2">
                {providers?.slice(0, 6).map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: meta.color }}>{initials(p.name)}</div>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-resq-navy">{p.name}<Stars rating={p.rating} /><VerifiedBadge verified={p.verified} /></p>
                      <p className="text-xs text-resq-slate">{fmtDistance(p.distanceKm)} away · {fmtRate(p.rate)}</p>
                    </div>
                    <PulsingDot color="cyan" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {h && (r.status === "matched" || r.status === "resolved") && (
            <section className="card-shadow-lg animate-slide-up rounded-2xl border border-slate-100 bg-white p-5">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-lg" style={{ background: meta.color }}>{initials(h.name)}</div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-bold text-resq-navy">{h.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5"><Stars rating={h.reliability * 5} /><VerifiedBadge verified={h.verified} /></div>
                  <p className="mt-1 text-sm text-resq-slate">{meta.label} · charges <strong className="text-resq-navy">{fmtRate(h.rate)}</strong></p>
                </div>
              </div>
              {r.status === "matched" && (
                <>
                  <div className="mt-4 flex items-center justify-center gap-3">
                    {arrived ? <Badge variant="success">Arrived at your location</Badge> : <>
                      <ETABadge minutes={etaMinutes(h.distanceKm)} />
                      <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-medium text-resq-navy">{fmtDistance(h.distanceKm)} away</span>
                    </>}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <a href={`tel:${h.phone}`} className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-resq-navy text-sm font-semibold text-white shadow-lg"><Icon.Phone size={18} />Call</a>
                    <a href={`sms:${h.phone}`} className="card-shadow flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-resq-navy"><Icon.MessageSquare size={18} />Message</a>
                  </div>
                </>
              )}
            </section>
          )}

          {h && r.status === "matched" && <VoiceNotes requestId={id} myLanguage={myLang} />}

          <PaymentPanel requestId={id} workerName={h?.name ?? "your provider"} status={r.status} />

          {r.status === "resolved" && (
            <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-5">
              <p className="text-center font-display font-semibold text-resq-navy">{stars ? "Thanks for rating" : `How was ${h?.name ?? "the service"}?`}</p>
              <div className="mt-2 flex justify-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} aria-label={`${n} stars`} disabled={stars > 0} onClick={() => { setStars(n); void patch({ action: "rate", stars: n }); }}
                    className={`flex h-12 w-12 items-center justify-center rounded-xl ${n <= stars ? "text-amber-400" : "text-slate-300"}`}><Icon.Star size={28} /></button>
                ))}
              </div>
            </section>
          )}

          {r.status === "searching" && (
            <button onClick={() => { if (confirm("Cancel this request?")) void patch({ action: "cancel" }); }}
              className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-resq-slate">Cancel request</button>
          )}
          {(r.status === "resolved" || r.status === "cancelled") && (
            <button onClick={onClose} className="min-h-12 w-full rounded-2xl bg-resq-navy font-semibold text-white">Back to home</button>
          )}
        </div>

        {r.location && (r.status === "matched" || r.status === "searching") && (
          <section className="card-shadow relative overflow-hidden rounded-2xl">
            <LiveMap center={r.location} radiusKm={h?.distanceKm ? Math.max(0.4, h.distanceKm * 1.4) : 2} rings={r.status === "searching" ? [1] : []}
              markers={markers} height={320} route={h?.location && r.status === "matched" ? [h.location, r.location] : undefined} />
            <div className="absolute left-4 top-4 rounded-xl border border-slate-100 bg-white px-3 py-1.5 text-xs font-bold text-resq-navy shadow">
              {r.status === "matched" ? (arrived ? "Arrived" : `Live · ${fmtDistance(h?.distanceKm)}`) : "Waiting for a provider"}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
