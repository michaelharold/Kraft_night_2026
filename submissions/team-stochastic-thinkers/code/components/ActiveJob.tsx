"use client";
/*
 * The job a user accepted: full requester details, live map to them, call buttons, and the end of the job.
 *
 * "Mark as done" is no longer one tap on a paid service, and deliberately so. A worker who has just finished is
 * standing in somebody's kitchen with their hands dirty, and that is the only moment they will reliably name a
 * price: ask afterwards and the figure arrives by phone call, or not at all. So the button opens the charge step
 * (WorkerMoneyPanel), the amount is stored server-side before the job is resolved, and the worker reads what it
 * leaves them — work minus the platform fee, plus whatever parts the customer approved — before they close the
 * job. Free emergencies and the fixed-fee micro-gigs keep the single tap they always had.
 */
import { JobBrief } from "./JobBrief";
import { Icon } from "./icons";
import { Badge } from "./ui";
import { LiveMap, type MapMarker } from "./LiveMap";
import { HazardBanner } from "./HazardBanner";
import { WorkerMoneyPanel, type DoneSummary } from "./PaymentPanel";
import { fmtRate } from "./ServiceRequestView";
import { fmtDistance, distanceKm, type LatLng } from "@/lib/client/api";
import { TYPE_LABELS, SKILL_LABELS } from "@/lib/taxonomy";
import { GIG_TYPES, categoryOf, feeOf, formatMoney } from "@/lib/policy";
import type { HelpRequest, RateRange } from "@/lib/types";

export function PersonDetails({ r }: { r: HelpRequest }) {
  const p = r.requesterProfile;
  const rows: [string, string | null | undefined][] = [
    ["Name", r.requesterName], ["Phone", r.requesterPhone], ["Age", p?.age ? String(p.age) : null], ["Blood group", p?.bloodGroup],
    ["Medical notes", p?.medicalNotes], ["Address", p?.address],
    ["Emergency contact", p?.emergencyContactName || p?.emergencyContactPhone ? `${p?.emergencyContactName ?? ""} ${p?.emergencyContactPhone ?? ""}`.trim() : null],
    ["Who needs help", r.role === "self" ? "The requester themselves" : "Someone with the requester"],
    ["Location", r.location ? `${r.location.lat.toFixed(6)}, ${r.location.lng.toFixed(6)}${r.landmark ? ` (near ${r.landmark})` : ""}` : "Not shared"],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-resq-slate">{k}</dt><dd className={`font-medium text-resq-navy ${k === "Medical notes" ? "text-resq-red" : ""}`}>{v}</dd></div>
      ))}
    </dl>
  );
}

export function ActiveJob({ r, mapsUrl, me, simulated, myRate, onDone }: {
  r: HelpRequest; mapsUrl: string | null; me: LatLng | null; simulated: boolean; myRate: RateRange | null;
  onDone: (summary: DoneSummary) => void | Promise<void>;
}) {
  const dist = me && r.location ? distanceKm(me, r.location) : null;
  const arrived = dist !== null && dist < 0.05;
  const markers: MapMarker[] = [];
  if (r.location) markers.push({ id: "req", at: r.location, color: "#DC2626", kind: "target", label: "Help" });
  if (me) markers.push({ id: "me", at: me, color: "#16A34A", kind: "you", label: "You", pulse: false });
  const gig = categoryOf(r) === "HOUSEHOLD_MICROGIG";
  const gigLabel = gig ? (r.gigType ? GIG_TYPES[r.gigType].label : "Household job") : null;
  const paid = categoryOf(r) === "SERVICE";
  const service = paid && r.service ? SKILL_LABELS[r.service] : null;
  return (
    <section className="card-shadow-lg animate-slide-up overflow-hidden rounded-2xl border-2 border-resq-green bg-white">
      <div className="bg-success-gradient px-5 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="success">Your current job</Badge>
          {service ? <Badge variant="default">{service}</Badge> : gig ? <Badge variant="warning">Paid job · {gigLabel}</Badge> : <Badge variant="default">Free · life safety</Badge>}
        </div>
        <h2 className="mt-2 font-display text-xl font-bold text-white">{service ?? (gig ? gigLabel : r.triage ? TYPE_LABELS[r.triage.type] : "Emergency")} · {r.requesterName ?? "Customer"}</h2>
        <p className="text-sm text-white/80">{arrived ? "You have arrived" : dist !== null ? `${fmtDistance(dist)} away${simulated ? " · simulated travel" : " · live GPS"}` : "Location not shared"}</p>
      </div>
      <div className="space-y-3 p-4">
        {/* The helper walks into the same scene: show them the curated hazard warning too. */}
        <HazardBanner alert={r.triage?.hazardAlert} compact />
        {gig && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-resq-amber text-white"><Icon.Shield size={18} /></div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-900">You earn {formatMoney(feeOf(r))} when you mark this job done</p>
              <p className="text-xs text-amber-800">{gigLabel} · callout fee {r.escrowStatus === "RELEASED" ? "released to your wallet" : "held in escrow"}</p>
            </div>
          </div>
        )}
        <p className="rounded-xl bg-slate-50 p-3 text-sm text-resq-navy">“{r.description}”</p>
        <JobBrief r={r} />
        <PersonDetails r={r} />
        {r.location && (
          <div className="overflow-hidden rounded-2xl">
            <LiveMap center={r.location} radiusKm={Math.max(0.3, (dist ?? 0.5) * 1.3)} markers={markers} height={190} route={me ? [me, r.location] : undefined} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {mapsUrl && <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-resq-navy text-sm font-semibold text-white"><Icon.Navigation size={16} />Navigate</a>}
          {r.requesterPhone && <a href={`tel:${r.requesterPhone}`} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-resq-navy"><Icon.Phone size={16} />Call</a>}
        </div>
        {paid ? (
          <WorkerMoneyPanel requestId={r.id} rateHint={myRate ? fmtRate(myRate) : null} customerName={r.requesterName ?? "The customer"} onDone={onDone} />
        ) : (
          <button onClick={() => void onDone(null)} className="min-h-14 w-full rounded-2xl bg-success-gradient font-display text-lg font-bold text-white">Mark as done</button>
        )}
      </div>
    </section>
  );
}

/** Short two-tone alert via Web Audio. Browsers allow it after the user has interacted with the page. */
export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.start(t0); o.stop(t0 + 0.17);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch { /* no audio */ }
}
