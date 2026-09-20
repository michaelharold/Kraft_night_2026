"use client";
/* Coordinator dashboard: live SVG map, open + escalated requests, coverage by skill, SMS log and simulator. */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Logo, PulsingDot } from "@/components/ui";
import { SKILL_META, SkillPill, URGENCY_STYLE } from "@/components/skills";
import { EquipmentPill } from "@/components/equipment";
import { TIER_META, TrustBadge } from "@/components/TrustBadge";
import { LiveMap, type MapArea, type MapMarker } from "@/components/LiveMap";
import { api, fmtDistance, fmtTime } from "@/lib/client/api";
import { useSnapshot } from "@/lib/client/sse";
import { SKILLS, TYPE_LABELS } from "@/lib/taxonomy";
import { GIG_TYPES, TRUST_TIERS, categoryOf, feeOf, formatMoney, tierOf } from "@/lib/policy";
import type { AuditEntry, HelpRequest, LatLng, OpsView, Zone, ZoneKind } from "@/lib/types";

type SmsLog = { to: string; body: string; at: string; simulated: boolean; ok: boolean };
type Ops = OpsView & { sms: SmsLog[]; smsSimulated: boolean };

const STATUS_COLOR: Record<string, string> = { triaging: "#0EA5E9", searching: "#D97706", matched: "#16A34A", escalated: "#DC2626", resolved: "#64748B", cancelled: "#94A3B8" };

export default function OpsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => { void api("/api/ops/requests").then((r) => setAuthed(r.ok)); }, []);
  if (authed === null) return <div className="flex min-h-dvh items-center justify-center text-resq-slate">Loading…</div>;
  return authed ? <Dashboard onSignOut={() => setAuthed(false)} /> : <Login onDone={() => setAuthed(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [user, setUser] = useState("coordinator");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api("/api/ops/login", { body: { username: user, password: pw } });
    if (r.ok) onDone(); else setErr("Wrong username or password.");
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy-gradient p-5">
      <form onSubmit={submit} className="card-shadow-lg w-full max-w-sm rounded-3xl bg-white p-6">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-resq-red"><Logo size={30} /></div>
        <h1 className="font-display text-2xl font-bold text-resq-navy">Authority sign-in</h1>
        <p className="mt-1 text-sm text-resq-slate">District control, ward officers and NGOs. Every access to people&apos;s locations is logged.</p>
        <label htmlFor="user" className="mt-5 block text-sm font-semibold text-resq-navy">Username</label>
        <input id="user" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)}
          className="mt-1.5 min-h-12 w-full rounded-xl border border-slate-200 px-4 outline-none focus:ring-2 focus:ring-resq-navy/30" />
        <label htmlFor="pw" className="mt-4 block text-sm font-semibold text-resq-navy">Password</label>
        <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)}
          className="mt-1.5 min-h-12 w-full rounded-xl border border-slate-200 px-4 outline-none focus:ring-2 focus:ring-resq-navy/30" />
        {err && <p role="alert" className="mt-2 text-sm font-medium text-resq-red">{err}</p>}
        <button className="mt-4 min-h-12 w-full rounded-xl bg-resq-navy font-semibold text-white">Sign in</button>
        <p className="mt-3 text-xs text-resq-slate">Demo: coordinator / resq-ops (set OPS_USER / OPS_PASSWORD).</p>
      </form>
    </div>
  );
}

type Tab = "dispatch" | "verify" | "team";
function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const { data, connected, refresh } = useSnapshot<Ops>("/api/ops/stream", "/api/ops/requests");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("dispatch");
  const [me, setMe] = useState<{ user: string; name: string; role: string } | null>(null);
  useEffect(() => { void api<{ user: string; name: string; role: string }>("/api/ops/me").then((r) => r.ok && setMe(r.data)); }, []);
  const signOut = async () => { await api("/api/ops/login", { method: "DELETE" }); onSignOut(); };

  // The ops GET also advances overdue waves (SMS-in and abandoned requests have no requester screen ticking them).
  useEffect(() => { const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const helperById = useMemo(() => new Map((data?.helpers ?? []).map((h) => [h.id, h])), [data]);
  if (!data) return <div className="flex min-h-dvh items-center justify-center text-resq-slate">Connecting…</div>;

  const onDuty = data.helpers.filter((h) => h.onDuty && h.location);
  const escalated = data.requests.filter((r) => r.status === "escalated");
  const open = data.requests.filter((r) => r.status !== "escalated");
  const coverage = SKILLS.map((s) => ({ s, n: onDuty.filter((h) => h.skills.includes(s)).length }));
  const maxCov = Math.max(1, ...coverage.map((c) => c.n));
  const byTier = TRUST_TIERS.map((tier) => ({ tier, n: onDuty.filter((h) => tierOf(h) === tier).length }));
  const markers: MapMarker[] = [
    ...data.helpers.filter((h) => h.location).map((h) => ({
      id: h.id, at: h.location!, kind: "helper" as const, label: `${h.name} · ${TIER_META[tierOf(h)].label} · ${h.skills.map((s) => SKILL_META[s].label).join(", ")}`,
      color: h.onDuty ? SKILL_META[h.skills[0]].color : "#CBD5E1",
      ring: data.requests.some((r) => r.matchedHelperId === h.id && r.status === "matched") ? "#16A34A"
        : data.dispatches.some((d) => d.helperId === h.id && d.status === "pinged") ? "#D97706" : undefined,
    })),
    ...data.requests.filter((r) => r.location).map((r) => ({
      id: r.id, at: r.location!, kind: "request" as const, color: STATUS_COLOR[r.status], label: `${r.service ? SKILL_META[r.service].label : r.triage ? TYPE_LABELS[r.triage.type] : "Request"} · ${r.status}`,
    })),
  ];
  const sel = data.requests.find((r) => r.id === selected) ?? null;

  return (
    <div className="min-h-dvh bg-slate-100">
      <header className="bg-navy-gradient px-5 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-resq-red"><Logo size={24} /></div>
            <div><h1 className="font-display text-xl font-bold text-white">Sahaya Admin</h1><p className="text-xs text-white/60">Live requests · ID verification</p></div>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {[
              ["Open", data.requests.length, "#fff"], ["Searching", data.requests.filter((r) => r.status === "searching").length, "#FBBF24"],
              ["Matched", data.requests.filter((r) => r.status === "matched").length, "#4ADE80"], ["Escalated", escalated.length, "#F87171"],
              ["On duty", onDuty.length, "#7DD3FC"],
            ].map(([l, n, c]) => (
              <div key={String(l)} className="rounded-xl bg-white/10 px-3 py-1.5 text-center">
                <p className="font-mono text-lg font-bold" style={{ color: String(c) }}>{n}</p><p className="text-[11px] text-white/60">{l}</p>
              </div>
            ))}
            <span className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 text-xs font-semibold text-white"><PulsingDot color={connected ? "green" : "red"} />{connected ? "LIVE" : "Reconnecting"}</span>
            {me && (
              <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5 text-xs text-white">
                <Icon.User size={14} /><span><strong>{me.name}</strong> · {me.role}</span>
                <button onClick={signOut} className="ml-1 rounded-lg bg-white/15 px-2 py-1 font-semibold">Sign out</button>
              </div>
            )}
          </div>
        </div>
        <nav className="mx-auto mt-4 flex max-w-7xl gap-1" aria-label="Sections">
          {([["dispatch", "Live requests"], ["verify", "ID verification"], ["team", "Team & audit"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
              className={`min-h-10 rounded-xl px-4 text-sm font-semibold ${tab === id ? "bg-white text-resq-navy" : "text-white/70 hover:text-white"}`}>{label}</button>
          ))}
        </nav>
      </header>
      {tab === "verify" && <VerifyTab />}
      {tab === "team" && <TeamTab isAdmin={me?.role === "admin"} />}

      <main className={`mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[1.4fr_1fr] ${tab === "dispatch" ? "" : "hidden"}`}>
        <section className="space-y-4">
          <div className="card-shadow overflow-hidden rounded-2xl bg-white">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="font-display font-semibold text-resq-navy">Live map</h2>
              <p className="text-xs text-resq-slate">Rings: wave radii 1 · 2 · 4 · 8 km</p>
            </div>
            <LiveMap center={data.center} radiusKm={5.5} rings={[1, 2, 4, 8]} markers={markers} height={460} />
            <div className="flex flex-wrap gap-3 px-4 py-3 text-xs text-resq-slate">
              {Object.entries(STATUS_COLOR).slice(0, 4).map(([s, c]) => <span key={s} className="flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: c }} />{s}</span>)}
              <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full border-2 border-amber-500" />helper pinged</span>
              <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-slate-300" />off duty</span>
            </div>
          </div>

          <div className="card-shadow rounded-2xl bg-white p-4">
            <h2 className="mb-3 font-display font-semibold text-resq-navy">Coverage by skill (on duty)</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {coverage.map(({ s, n }) => (
                <div key={s} className="flex items-center gap-2">
                  <span className="w-24 text-xs font-medium text-resq-navy">{SKILL_META[s].label}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${(n / maxCov) * 100}%`, background: SKILL_META[s].color }} /></div>
                  <span className={`w-6 text-right font-mono text-xs font-bold ${n === 0 ? "text-resq-red" : "text-resq-navy"}`}>{n}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-slate-100 pt-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-resq-slate">Helpers by badge (on duty)</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                {byTier.map(({ tier, n }) => (
                  <div key={tier} title={TIER_META[tier].desc} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2">
                    <TrustBadge tier={tier} />
                    <span className={`font-mono text-lg font-bold ${n === 0 ? "text-resq-red" : "text-resq-navy"}`}>{n}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-resq-slate">Paid household jobs only ping Certified Pros. Critical life-safety requests rank First Responders first in wave 1.</p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {escalated.length > 0 && (
            <div className="card-shadow rounded-2xl border-2 border-resq-red bg-white p-4">
              <h2 className="mb-2 flex items-center gap-2 font-display font-semibold text-resq-red"><Icon.AlertTriangle size={18} />Escalated: needs a human ({escalated.length})</h2>
              <div className="space-y-2">{escalated.map((r) => <RequestRow key={r.id} r={r} data={data} onSelect={setSelected} selected={selected === r.id} />)}</div>
            </div>
          )}
          <div className="card-shadow rounded-2xl bg-white p-4">
            <h2 className="mb-2 font-display font-semibold text-resq-navy">Open requests ({open.length})</h2>
            <div className="space-y-2">
              {open.length === 0 && <p className="text-sm text-resq-slate">Nothing open right now.</p>}
              {open.map((r) => <RequestRow key={r.id} r={r} data={data} onSelect={setSelected} selected={selected === r.id} />)}
            </div>
          </div>
          {sel && (
            <div className="card-shadow rounded-2xl bg-white p-4">
              <div className="mb-2 flex items-center justify-between"><h2 className="font-display font-semibold text-resq-navy">Dispatches</h2><button onClick={() => setSelected(null)} className="h-10 w-10" aria-label="Close"><Icon.X size={16} /></button></div>
              <p className="mb-3 text-sm text-resq-navy">“{sel.description}”</p>
              <table className="w-full text-left text-xs">
                <thead className="text-resq-slate"><tr><th className="py-1">Wave</th><th>Helper</th><th>Tier</th><th>Dist</th><th>Score</th><th>Status</th></tr></thead>
                <tbody>
                  {data.dispatches.filter((d) => d.requestId === sel.id).map((d) => (
                    <tr key={d.id} className="border-t border-slate-100">
                      <td className="py-1.5 font-mono">{d.wave}</td>
                      <td>{helperById.get(d.helperId)?.name ?? d.helperId}</td>
                      <td><TrustBadge tier={tierOf(helperById.get(d.helperId))} compact /></td>
                      <td>{fmtDistance(d.distanceKm)}</td>
                      <td className="font-mono">{d.score.toFixed(2)}</td>
                      <td><span className="font-semibold">{d.status}</span>{d.channel === "sms" && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">SMS</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DemoControls data={data} />
          <SmsPanel data={data} />
        </section>
      </main>
    </div>
  );
}

function RequestRow({ r, data, onSelect, selected }: { r: HelpRequest; data: Ops; onSelect: (id: string) => void; selected: boolean }) {
  const ds = data.dispatches.filter((d) => d.requestId === r.id);
  const helper = r.matchedHelperId ? data.helpers.find((h) => h.id === r.matchedHelperId) : null;
  return (
    <button onClick={() => onSelect(r.id)} className={`w-full rounded-xl border p-3 text-left transition-colors ${selected ? "border-resq-navy bg-slate-50" : "border-slate-100 hover:bg-slate-50"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[r.status] }} />
        <span className="text-sm font-semibold text-resq-navy">{r.service ? SKILL_META[r.service].label : r.triage ? TYPE_LABELS[r.triage.type] : "Triaging…"}</span>
        {r.triage && <span className={`rounded px-1.5 text-[10px] font-bold uppercase ${URGENCY_STYLE[r.triage.urgency]}`}>{r.triage.urgency}</span>}
        {r.channel === "sms" && <Badge variant="warning">SMS-in</Badge>}
        {!r.location && <Badge variant="emergency">No location</Badge>}
        <CategoryChip r={r} />
        {r.upgradedToLifeSafety && <Badge variant="emergency">Upgraded to emergency</Badge>}
        {r.triage?.hazardAlert?.hasHazard && <Badge variant="warning"><Icon.AlertTriangle size={11} />Hazard: {r.triage.hazardAlert.kind.replace(/_/g, " ")}</Badge>}
        {r.emergencyContactNotifiedAt && <Badge variant="ai">Emergency contact texted</Badge>}
        <span className="ml-auto font-mono text-xs text-resq-slate">{fmtTime(r.createdAt)}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-resq-slate">{r.description}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-resq-slate">
        <span className="font-semibold capitalize" style={{ color: STATUS_COLOR[r.status] }}>{r.status}</span>
        {r.wave > 0 && <span>· wave {r.wave} ({r.radiusKm} km)</span>}
        <span>· {ds.length} pinged</span>
        {r.landmark && <span>· near {r.landmark}</span>}
        {r.requesterPhone && <a href={`tel:${r.requesterPhone}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-resq-cyan">· call {r.requesterPhone}</a>}
        {helper && <span>· helper {helper.name}</span>}
      </div>
      {r.triage && <div className="mt-1.5 flex flex-wrap gap-1">{r.triage.skills.map((s) => <SkillPill key={s} skill={s} />)}{(r.triage.equipment ?? []).map((e) => <EquipmentPill key={e} item={e} />)}</div>}
    </button>
  );
}

/** "FREE · life safety" or "Paid · ₹500 · HELD|RELEASED|REFUNDED" (older records without a category are life-safety). */
function CategoryChip({ r }: { r: HelpRequest }) {
  if (categoryOf(r) === "LIFE_SAFETY") return <Badge variant="success">FREE · life safety</Badge>;
  const state = r.escrowStatus ?? "HELD";
  const cls = state === "RELEASED" ? "bg-resq-green-light text-resq-green" : state === "REFUNDED" ? "bg-slate-100 text-slate-600" : "bg-blue-50 text-blue-700";
  return (
    <span title={r.gigType ? GIG_TYPES[r.gigType].label : undefined} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      Paid · {formatMoney(feeOf(r))} · {state}
    </span>
  );
}

function SmsPanel({ data }: { data: Ops }) {
  const [open, setOpen] = useState(data.smsSimulated);
  const [from, setFrom] = useState("+919000000099");
  const [body, setBody] = useState("HELP trapped near TKMCE hostel");
  const [reply, setReply] = useState<string | null>(null);
  const send = async () => {
    const res = await fetch("/api/twilio/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: from, Body: body }) });
    const xml = await res.text();
    setReply(new DOMParser().parseFromString(xml, "text/xml").querySelector("Message")?.textContent ?? xml);
  };
  return (
    <div className="card-shadow rounded-2xl bg-white p-4">
      <button onClick={() => setOpen(!open)} className="flex min-h-10 w-full items-center justify-between">
        <h2 className="flex items-center gap-2 font-display font-semibold text-resq-navy"><Icon.Radio size={16} />SMS {data.smsSimulated && <Badge variant="warning">simulated</Badge>}</h2>
        <Icon.ChevronRight size={16} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="mb-2 text-xs font-semibold text-resq-navy">Simulate an inbound SMS (YES / NO / HELP …)</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="min-h-10 rounded-lg border border-slate-200 px-3 text-sm sm:w-40" />
              <input value={body} onChange={(e) => setBody(e.target.value)} aria-label="Body" className="min-h-10 flex-1 rounded-lg border border-slate-200 px-3 text-sm" />
              <button onClick={send} className="min-h-10 rounded-lg bg-resq-navy px-4 text-sm font-semibold text-white">Send</button>
            </div>
            <p className="mt-1.5 text-[11px] text-resq-slate">Seeded helpers use +919000000001 … +919000000030.</p>
            {reply && <p className="mt-2 rounded-lg bg-white p-2 text-xs text-resq-navy">↩ {reply}</p>}
          </div>
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {data.sms.length === 0 && <p className="text-xs text-resq-slate">No outbound SMS yet.</p>}
            {data.sms.map((m, i) => (
              <div key={i} className="rounded-lg border border-slate-100 p-2 text-xs">
                <div className="flex justify-between text-resq-slate"><span className="font-mono">→ {m.to}</span><span>{fmtTime(m.at)}{!m.ok && <span className="ml-1 text-resq-red">failed</span>}</span></div>
                <p className="mt-0.5 text-resq-navy">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DemoControls({ data }: { data: Ops }) {
  const [msg, setMsg] = useState<string | null>(null);
  const seededOn = data.helpers.filter((h) => h.id.startsWith("seed-helper-") && h.onDuty).length;
  const act = async (action: string, label: string) => {
    const r = await api<{ helpers?: number; cancelled?: number }>("/api/ops/demo", { body: { action } });
    setMsg(r.ok ? label : `Failed (${r.error})`);
  };
  return (
    <div className="card-shadow rounded-2xl bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-semibold text-resq-navy">Demo controls</h2>
        <a href="/demo" target="_blank" className="text-sm font-semibold text-resq-cyan">Open launcher →</a>
      </div>
      <p className="mt-1 text-xs text-resq-slate">{seededOn} of 30 seeded helpers on duty. Switch them off so only real helper windows get pinged.</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button onClick={() => act("seeded_off", "Seeded helpers are off duty")} className="min-h-11 rounded-xl bg-resq-navy text-xs font-semibold text-white">Seeded helpers off</button>
        <button onClick={() => act("seeded_on", "Seeded helpers are on duty")} className="min-h-11 rounded-xl border border-slate-200 text-xs font-semibold text-resq-navy">Seeded helpers on</button>
        <button onClick={() => { if (confirm("Cancel every open request?")) void act("reset", "All open requests cancelled"); }} className="min-h-11 rounded-xl border border-resq-red/30 bg-resq-red-light text-xs font-semibold text-resq-red">Reset requests</button>
      </div>
      {msg && <p className="mt-2 text-xs font-medium text-resq-green">{msg}</p>}
    </div>
  );
}

// ─── Disaster zones ────────────────────────────────────────────────────────────────────────────────────────

type ZonePerson = { key: string; kind: "resident" | "helper" | "requester"; name: string | null; phone: string | null; skills: string[];
  lat: number; lng: number; accuracyM: number | null; source: string; updatedAt: string; ageMin: number; distanceKm: number;
  inZoneNow: boolean; lastInZoneAt: string | null; mapsUrl: string; note: string | null };
const KINDS: { id: ZoneKind; label: string; color: string }[] = [
  { id: "landslide", label: "Landslide", color: "#92400E" }, { id: "flood", label: "Flood", color: "#0284C7" },
  { id: "fire", label: "Fire", color: "#EA580C" }, { id: "building_collapse", label: "Building collapse", color: "#7C3AED" },
  { id: "cyclone", label: "Cyclone", color: "#0F766E" }, { id: "other", label: "Other", color: "#DC2626" },
];
const kindColor = (k: ZoneKind) => KINDS.find((x) => x.id === k)?.color ?? "#DC2626";
const PERSON_COLOR = { resident: "#2563EB", helper: "#16A34A", requester: "#DC2626" } as const;

function ZonesTab({ center }: { center: LatLng }) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [people, setPeople] = useState<ZonePerson[] | null>(null);
  const [draft, setDraft] = useState<{ center: LatLng | null; radiusKm: number; name: string; kind: ZoneKind }>({ center: null, radiusKm: 0.8, name: "", kind: "landslide" });
  const [msg, setMsg] = useState<string | null>(null);
  const [alertText, setAlertText] = useState("Move to higher ground or the nearest relief camp now. Rescue teams are on the way.");
  const [filter, setFilter] = useState<"all" | "now" | "was">("all");

  const loadZones = async () => { const r = await api<{ zones: Zone[] }>("/api/ops/zones"); if (r.ok) setZones(r.data.zones); };
  useEffect(() => { void loadZones(); }, []);
  const zone = zones.find((z) => z.id === sel) ?? null;
  // Locations refresh every 15 s while a zone is open (people keep sharing every 30 s). Only the first load is audited.
  useEffect(() => {
    if (!sel) { setPeople(null); return; }
    let first = true;
    const load = async () => {
      const r = await api<{ people: ZonePerson[] }>(`/api/ops/zones/${sel}/people${first ? "" : "?quiet=1"}`);
      first = false;
      if (r.ok) setPeople(r.data.people);
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [sel]);

  const create = async () => {
    if (!draft.center || !draft.name.trim()) { setMsg("Click the map to set the centre and give the zone a name."); return; }
    const r = await api<{ zone: Zone }>("/api/ops/zones", { body: { name: draft.name.trim(), kind: draft.kind, center: draft.center, radiusKm: draft.radiusKm } });
    if (!r.ok) { setMsg(`Could not create zone (${r.error}).`); return; }
    setMsg(null); setDraft({ ...draft, center: null, name: "" }); await loadZones(); setSel(r.data.zone.id);
  };
  const close = async (z: Zone) => { await api(`/api/ops/zones/${z.id}`, { method: "PATCH", body: { active: !z.active } }); await loadZones(); };
  const sendAlert = async () => {
    if (!zone || !confirm(`Send this SMS to everyone found in ${zone.name}?`)) return;
    const r = await api<{ sent: number; failed: number }>(`/api/ops/zones/${zone.id}/alert`, { body: { message: alertText } });
    setMsg(r.ok ? `Alert sent to ${r.data.sent} phones${r.data.failed ? `, ${r.data.failed} failed` : ""}.` : `Alert failed (${r.error}).`);
  };
  const csv = () => {
    if (!zone || !people) return;
    const rows = [["name", "phone", "type", "latitude", "longitude", "accuracy_m", "last_update", "in_zone_now", "last_in_zone", "distance_from_centre_km", "note"],
      ...people.map((p) => [p.name ?? "", p.phone ?? "", p.kind, p.lat, p.lng, p.accuracyM ?? "", p.updatedAt, p.inZoneNow, p.lastInZoneAt ?? "", p.distanceKm, p.note ?? ""])];
    const blob = new Blob([rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `resq-${zone.name.replace(/\W+/g, "-")}.csv`; a.click();
  };

  const shown = (people ?? []).filter((p) => filter === "all" || (filter === "now" ? p.inZoneNow : !p.inZoneNow));
  const areas: MapArea[] = [
    ...zones.filter((z) => z.active || z.id === sel).map((z) => ({ id: z.id, center: z.center, radiusKm: z.radiusKm, color: kindColor(z.kind), label: z.name, selected: z.id === sel })),
    ...(draft.center ? [{ id: "draft", center: draft.center, radiusKm: draft.radiusKm, color: kindColor(draft.kind), label: draft.name || "New zone", selected: true }] : []),
  ];
  const markers: MapMarker[] = shown.map((p) => ({ id: p.key, at: { lat: p.lat, lng: p.lng }, kind: "helper", color: PERSON_COLOR[p.kind], label: `${p.name ?? "Unknown"} ${p.phone ?? ""}`, ring: p.inZoneNow ? undefined : "#F59E0B" }));

  return (
    <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[1.3fr_1fr]">
      <section className="space-y-4">
        <div className="card-shadow overflow-hidden rounded-2xl bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 className="font-display font-semibold text-resq-navy">Affected area map</h2>
            <p className="text-xs text-resq-slate">Click the map to place a new zone’s centre</p>
          </div>
          <LiveMap center={zone?.center ?? center} radiusKm={Math.max(2.5, (zone?.radiusKm ?? 1) * 1.8)} rings={[]} markers={markers} areas={areas} height={440}
            onPick={(p) => setDraft((d) => ({ ...d, center: p }))} />
          <div className="flex flex-wrap gap-3 px-4 py-3 text-xs text-resq-slate">
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: PERSON_COLOR.requester }} />asked for help</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: PERSON_COLOR.helper }} />helper</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: PERSON_COLOR.resident }} />resident</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full border-2 border-amber-500" />was in zone, has left</span>
          </div>
        </div>

        <div className="card-shadow rounded-2xl bg-white p-4">
          <h2 className="mb-3 font-display font-semibold text-resq-navy">Declare an affected zone</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold text-resq-navy">Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Karicode landslide"
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 font-normal" /></label>
            <label className="text-sm font-semibold text-resq-navy">Type
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ZoneKind })} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 font-normal">
                {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select></label>
            <label className="text-sm font-semibold text-resq-navy sm:col-span-2">Radius: {draft.radiusKm < 1 ? `${Math.round(draft.radiusKm * 1000)} m` : `${draft.radiusKm.toFixed(1)} km`}
              <input type="range" min={0.1} max={5} step={0.05} value={draft.radiusKm} onChange={(e) => setDraft({ ...draft, radiusKm: Number(e.target.value) })} className="mt-2 w-full accent-resq-red" /></label>
          </div>
          <p className="mt-2 text-xs text-resq-slate">Centre: {draft.center ? `${draft.center.lat.toFixed(5)}, ${draft.center.lng.toFixed(5)}` : "click the map"}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={create} className="min-h-11 flex-1 rounded-xl bg-resq-red font-semibold text-white">Declare zone & find people</button>
            {draft.center && <button onClick={() => setDraft({ ...draft, center: null })} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-resq-slate">Clear</button>}
          </div>
          {msg && <p className="mt-2 text-sm font-medium text-resq-navy">{msg}</p>}
        </div>

        <div className="card-shadow rounded-2xl bg-white p-4">
          <h2 className="mb-2 font-display font-semibold text-resq-navy">Zones</h2>
          {zones.length === 0 && <p className="text-sm text-resq-slate">No zones declared.</p>}
          <div className="space-y-2">
            {zones.map((z) => (
              <div key={z.id} className={`flex items-center gap-2 rounded-xl border p-3 ${sel === z.id ? "border-resq-navy bg-slate-50" : "border-slate-100"}`}>
                <span className="h-3 w-3 rounded-full" style={{ background: kindColor(z.kind) }} />
                <button onClick={() => setSel(z.id)} className="flex-1 text-left">
                  <p className="text-sm font-semibold text-resq-navy">{z.name} {!z.active && <span className="text-xs text-resq-slate">(closed)</span>}</p>
                  <p className="text-xs text-resq-slate">{KINDS.find((k) => k.id === z.kind)?.label} · {z.radiusKm < 1 ? `${Math.round(z.radiusKm * 1000)} m` : `${z.radiusKm} km`} · by {z.createdBy} · {fmtTime(z.createdAt)}</p>
                </button>
                <button onClick={() => close(z)} className="min-h-9 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-resq-slate">{z.active ? "Close" : "Reopen"}</button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        {!zone && (
          <div className="card-shadow rounded-2xl bg-white p-6 text-center">
            <Icon.MapPin size={28} className="mx-auto text-resq-slate" />
            <p className="mt-2 font-display font-semibold text-resq-navy">Select or declare a zone</p>
            <p className="mt-1 text-sm text-resq-slate">You will see everyone who shares their location and is inside it now, or was inside it in the 6 hours before it was declared.</p>
          </div>
        )}
        {zone && (
          <div className="card-shadow rounded-2xl bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-bold text-resq-navy">{zone.name}</h2>
                <p className="text-xs text-resq-slate">Centre {zone.center.lat.toFixed(5)}, {zone.center.lng.toFixed(5)} · live, refreshes every 15 s</p>
              </div>
              <button onClick={csv} disabled={!people?.length} className="min-h-10 rounded-xl bg-resq-navy px-3 text-xs font-semibold text-white disabled:opacity-50">Export CSV</button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[["In zone now", (people ?? []).filter((p) => p.inZoneNow).length, "text-resq-red"], ["Were there", (people ?? []).filter((p) => !p.inZoneNow).length, "text-amber-600"],
                ["Asked for help", (people ?? []).filter((p) => p.kind === "requester").length, "text-resq-red"]].map(([l, n, c]) => (
                <div key={String(l)} className="rounded-xl bg-slate-50 p-2"><p className={`font-mono text-xl font-bold ${c}`}>{n}</p><p className="text-[11px] text-resq-slate">{l}</p></div>
              ))}
            </div>
            <div className="mt-3 flex gap-1 rounded-xl bg-slate-100 p-0.5 text-xs">
              {([["all", "All"], ["now", "In zone now"], ["was", "Were there"]] as const).map(([v, l]) => (
                <button key={v} onClick={() => setFilter(v)} className={`min-h-9 flex-1 rounded-lg font-semibold ${filter === v ? "bg-white text-resq-navy shadow" : "text-resq-slate"}`}>{l}</button>
              ))}
            </div>
            <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto">
              {people === null && <p className="text-sm text-resq-slate">Loading…</p>}
              {people && shown.length === 0 && <p className="text-sm text-resq-slate">Nobody found.</p>}
              {shown.map((p) => (
                <div key={p.key} className="rounded-xl border border-slate-100 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: PERSON_COLOR[p.kind] }} />
                    <span className="text-sm font-semibold text-resq-navy">{p.name ?? "Unknown person"}</span>
                    <Badge variant={p.kind === "requester" ? "emergency" : p.kind === "helper" ? "success" : "default"}>{p.kind}</Badge>
                    {!p.inZoneNow && <Badge variant="warning">left zone</Badge>}
                    <span className="ml-auto text-resq-slate">{p.ageMin === 0 ? "just now" : `${p.ageMin} min ago`}</span>
                  </div>
                  <p className="mt-1 font-mono text-resq-navy">{p.lat.toFixed(6)}, {p.lng.toFixed(6)}{p.accuracyM !== null && <span className="text-resq-slate"> ±{p.accuracyM} m</span>}</p>
                  <p className="mt-0.5 text-resq-slate">{fmtDistance(p.distanceKm)} from centre · via {p.source}{!p.inZoneNow && p.lastInZoneAt ? ` · last in zone ${fmtTime(p.lastInZoneAt)}` : ""}</p>
                  {p.note && <p className="mt-1 text-resq-red">{p.note}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.phone && <a href={`tel:${p.phone}`} className="rounded-lg bg-resq-navy px-2.5 py-1.5 font-semibold text-white">Call {p.phone}</a>}
                    <a href={p.mapsUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-resq-navy">Open in Maps</a>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl bg-resq-red-light p-3">
              <p className="mb-1.5 text-xs font-semibold text-resq-red">SMS everyone found in this zone</p>
              <textarea value={alertText} onChange={(e) => setAlertText(e.target.value)} maxLength={140} rows={2} className="w-full rounded-lg border border-resq-red/20 bg-white p-2 text-sm" />
              <button onClick={sendAlert} disabled={!people?.some((p) => p.phone)} className="mt-2 min-h-10 w-full rounded-lg bg-resq-red text-sm font-semibold text-white disabled:opacity-50">
                Send alert to {(people ?? []).filter((p) => p.phone).length} phones
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

// ─── Team & audit ──────────────────────────────────────────────────────────────────────────────────────────

function TeamTab({ isAdmin }: { isAdmin: boolean }) {
  const [team, setTeam] = useState<{ username: string; name: string; role: string; createdAt: string }[]>([]);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [form, setForm] = useState({ username: "", name: "", password: "", role: "officer" });
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    const [a, b] = await Promise.all([api<{ authorities: typeof team }>("/api/ops/authorities"), api<{ audit: AuditEntry[] }>("/api/ops/audit")]);
    if (a.ok) setTeam(a.data.authorities);
    if (b.ok) setLog(b.data.audit);
  };
  useEffect(() => { void load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api("/api/ops/authorities", { body: form });
    setMsg(r.ok ? `Account ${form.username} created.` : r.error === "password_too_short" ? "Password must be at least 8 characters." : r.error === "username_taken" ? "That username exists." : `Failed (${r.error}).`);
    if (r.ok) { setForm({ username: "", name: "", password: "", role: "officer" }); void load(); }
  };
  return (
    <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-2">
      <section className="card-shadow rounded-2xl bg-white p-4">
        <h2 className="mb-3 font-display font-semibold text-resq-navy">Authority accounts</h2>
        <div className="space-y-2">
          {team.map((a) => (
            <div key={a.username} className="flex items-center gap-3 rounded-xl border border-slate-100 p-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-resq-navy text-xs font-bold text-white">{a.name.slice(0, 2).toUpperCase()}</div>
              <div className="flex-1"><p className="text-sm font-semibold text-resq-navy">{a.name}</p><p className="text-xs text-resq-slate">{a.username}</p></div>
              <Badge variant={a.role === "admin" ? "emergency" : "default"}>{a.role}</Badge>
            </div>
          ))}
        </div>
        {isAdmin ? (
          <form onSubmit={add} className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
            <p className="text-sm font-semibold text-resq-navy sm:col-span-2">Add an officer</p>
            <input required placeholder="username (e.g. officer.kollam)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="min-h-10 rounded-lg border border-slate-200 px-3 text-sm" />
            <input required placeholder="Full name / office" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="min-h-10 rounded-lg border border-slate-200 px-3 text-sm" />
            <input required type="password" placeholder="Password (8+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="min-h-10 rounded-lg border border-slate-200 px-3 text-sm" />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="min-h-10 rounded-lg border border-slate-200 px-3 text-sm">
              <option value="officer">Officer</option><option value="admin">Admin</option>
            </select>
            <button className="min-h-10 rounded-lg bg-resq-navy text-sm font-semibold text-white sm:col-span-2">Create account</button>
            {msg && <p className="text-xs text-resq-navy sm:col-span-2">{msg}</p>}
          </form>
        ) : <p className="mt-3 text-xs text-resq-slate">Only admins can add accounts.</p>}
      </section>
      <section className="card-shadow rounded-2xl bg-white p-4">
        <h2 className="mb-1 font-display font-semibold text-resq-navy">Audit log</h2>
        <p className="mb-3 text-xs text-resq-slate">Who looked at people&apos;s locations, declared zones or sent alerts.</p>
        <div className="max-h-[520px] space-y-1.5 overflow-y-auto">
          {log.map((e, i) => (
            <div key={i} className="rounded-lg border border-slate-100 p-2 text-xs">
              <div className="flex justify-between"><span className="font-semibold text-resq-navy">{e.user} · {e.action.replace(/_/g, " ")}</span><span className="text-resq-slate">{fmtTime(e.at)}</span></div>
              <p className="mt-0.5 text-resq-slate">{e.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

// ─── ID verification ───────────────────────────────────────────────────────────────────────────────────────

type VerifyPerson = { id: string; name: string; phone: string; skills: string[]; rates: Record<string, { min: number; max: number }>;
  profile: { address: string | null } | null; idProof: { fileName: string; mime: string; size: number; uploadedAt: string; status: "pending" | "verified" | "rejected"; reviewedBy: string | null; reviewedAt: string | null; note: string | null } };

function VerifyTab() {
  const [people, setPeople] = useState<VerifyPerson[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await api<{ people: VerifyPerson[] }>("/api/ops/verifications"); if (r.ok) setPeople(r.data.people); };
  useEffect(() => { void load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const p = people?.find((x) => x.id === sel) ?? null;
  const decide = async (decision: "verified" | "rejected") => {
    if (!p) return;
    setBusy(true);
    await api(`/api/ops/verifications/${p.id}`, { body: { decision, note } });
    setBusy(false); setNote(""); await load();
  };
  const chip = (s: string) => s === "verified" ? "bg-resq-green-light text-resq-green" : s === "rejected" ? "bg-resq-red-light text-resq-red" : "bg-amber-50 text-amber-700";
  return (
    <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[1fr_1.3fr]">
      <section className="card-shadow rounded-2xl bg-white p-4">
        <h2 className="mb-1 font-display font-semibold text-resq-navy">ID proofs</h2>
        <p className="mb-3 text-xs text-resq-slate">Pending first. Approving gives the provider the “ID verified” badge; they are told by SMS either way.</p>
        {people === null && <p className="text-sm text-resq-slate">Loading…</p>}
        {people?.length === 0 && <p className="text-sm text-resq-slate">No ID proofs uploaded yet.</p>}
        <div className="space-y-2">
          {people?.map((x) => (
            <button key={x.id} onClick={() => { setSel(x.id); setNote(""); }} className={`w-full rounded-xl border p-3 text-left ${sel === x.id ? "border-resq-navy bg-slate-50" : "border-slate-100 hover:bg-slate-50"}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-resq-navy">{x.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${chip(x.idProof.status)}`}>{x.idProof.status}</span>
                <span className="ml-auto text-xs text-resq-slate">{fmtTime(x.idProof.uploadedAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-resq-slate">{x.phone} · {x.skills.filter((s) => SKILL_META[s as keyof typeof SKILL_META]).map((s) => SKILL_META[s as keyof typeof SKILL_META].label).join(", ") || "no services"}</p>
            </button>
          ))}
        </div>
      </section>
      <section className="card-shadow rounded-2xl bg-white p-4">
        {!p ? <p className="p-6 text-center text-sm text-resq-slate">Select a person to review their document.</p> : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-bold text-resq-navy">{p.name}</h2>
                <p className="text-xs text-resq-slate">{p.phone}{p.profile?.address ? ` · ${p.profile.address}` : ""}</p>
              </div>
              <a href={`/api/ops/verifications/${p.id}`} target="_blank" rel="noopener noreferrer" className="min-h-10 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-resq-navy">Open in new tab</a>
            </div>
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {Object.entries(p.rates).map(([s, r]) => <li key={s} className="rounded-lg bg-slate-100 px-2 py-1 text-resq-navy">{SKILL_META[s as keyof typeof SKILL_META]?.label ?? s}: ₹{r.min}–₹{r.max}</li>)}
            </ul>
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              {p.idProof.mime === "application/pdf"
                ? <iframe title="ID proof" src={`/api/ops/verifications/${p.id}`} className="h-[420px] w-full" />
                // eslint-disable-next-line @next/next/no-img-element
                : <img alt={`ID proof of ${p.name}`} src={`/api/ops/verifications/${p.id}`} className="max-h-[420px] w-full object-contain" />}
            </div>
            <p className="mt-2 text-xs text-resq-slate">{p.idProof.fileName} · {(p.idProof.size / 1024).toFixed(0)} KB{p.idProof.reviewedBy ? ` · last reviewed by ${p.idProof.reviewedBy}` : ""}{p.idProof.note ? ` · note: ${p.idProof.note}` : ""}</p>
            <label className="mt-3 block text-sm font-semibold text-resq-navy">Note to the person <span className="font-normal text-resq-slate">(optional, sent with a rejection)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Photo is blurred, please re-upload" className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal" /></label>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={() => decide("verified")} className="min-h-12 rounded-xl bg-resq-green font-semibold text-white disabled:opacity-60">Approve · verified</button>
              <button disabled={busy} onClick={() => decide("rejected")} className="min-h-12 rounded-xl border-2 border-resq-red/40 bg-resq-red-light font-semibold text-resq-red disabled:opacity-60">Reject</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
