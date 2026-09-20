"use client";
/*
 * Sahaya — a local-services community ("Uber for neighbours and local professionals").
 *   sign in (phone + code) → profile (details, services you offer with a price range, ID proof) → home
 *   home: tap a service (Plumber, Electrician, Doctor…) → describe the problem → nearby providers get it live
 *         → one accepts → call / message / live map → they name their charge → pay in app (Razorpay) + rate
 *   providers: "Requests for you" with the requester's details → Accept / Not now → one job at a time
 *
 * The money lives in components/PaymentPanel.tsx on both sides; this file only routes between screens and, when a
 * provider closes a job, repeats back the figures the server computed for the charge.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Container, Logo, NavBar, PhoneShell, PulsingDot, initials } from "@/components/ui";
import { SKILL_META } from "@/components/skills";
import { tintOf } from "@/lib/theme";
import { OtpForm } from "@/components/OtpForm";
import { BeaconChip } from "@/components/BeaconChip";
import { ActiveJob, PersonDetails, beep } from "@/components/ActiveJob";
import type { DoneSummary } from "@/components/PaymentPanel";
import { ServiceRequestView, Stars, VerifiedBadge, fmtRate, type ProviderPreview } from "@/components/ServiceRequestView";
import { VoiceMic } from "@/components/VoiceMic";
import { TaskScopeModal } from "@/components/TaskScopeModal";
import { LiveMap, type MapMarker } from "@/components/LiveMap";
import { DEMO_RADIUS_KM, api, demoSpot, distanceKm, fmtDistance, fmtTime, getHelperToken, getPosition, setHelperToken, stepToward, type LatLng } from "@/lib/client/api";
import { useLocationBeacon } from "@/lib/client/beacon";
import { useSnapshot } from "@/lib/client/sse";
import { speechErrorText, useSpeech } from "@/lib/client/speech";
import { MAX_RECORD_SECONDS, recorderErrorText, useRecorder } from "@/lib/client/recorder";
import { languageLabel, languageOf, type LanguageCode } from "@/lib/languages";
import { LanguagePicker, LanguageNote } from "@/components/LanguagePicker";
import { VoiceNotes } from "@/components/VoiceNotes";
import { BLOOD_GROUPS, SERVICES, SERVICE_TOOLS, TOOL_LABELS, type Service } from "@/lib/taxonomy";
import { isVerified, rateFor } from "@/lib/policy";
import type { Dashboard, FeedItem } from "@/lib/feed";
import type { Helper, RateRange, RequestView, Skill, Tool, UserProfile } from "@/lib/types";

type Config = { seedCenter: LatLng };
type Screen = { name: "loading" } | { name: "auth" } | { name: "onboarding" } | { name: "profile" } | { name: "home" }
  | { name: "describe"; service: Service } | { name: "request"; id: string };
type ServiceSummary = { service: Service; count: number; verified: number; minRate: number | null; maxRate: number | null; nearestKm: number | null };

/** Where this person is: GPS if it is plausibly at the venue, else this window's demo spot near TKMCE. */
async function whereAmI(center: LatLng): Promise<{ at: LatLng; source: "gps" | "demo" }> {
  const p = await getPosition(6000);
  return p && distanceKm(p, center) <= DEMO_RADIUS_KM ? { at: p, source: "gps" } : { at: demoSpot(center), source: "demo" };
}

export default function SahayaApp() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [config, setConfig] = useState<Config | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);

  const refresh = useCallback(async () => {
    if (!getHelperToken()) { setScreen({ name: "auth" }); return; }
    const r = await api<Dashboard>("/api/dashboard");
    if (!r.ok) { setHelperToken(null); setScreen({ name: "auth" }); return; }
    setDash(r.data);
    setScreen((s) => (!r.data.me ? { name: "onboarding" } : s.name === "loading" || s.name === "auth" || s.name === "onboarding" ? { name: "home" } : s));
  }, []);

  useEffect(() => {
    void api<Config>("/api/config").then((r) => r.ok && setConfig(r.data));
    void refresh();
  }, [refresh]);

  const home = () => { setScreen({ name: "home" }); void refresh(); };
  return (
    <PhoneShell>
      {screen.name === "loading" && <div className="flex flex-1 items-center justify-center text-resq-slate">Loading…</div>}
      {screen.name === "auth" && <AuthScreen onDone={refresh} />}
      {(screen.name === "onboarding" || screen.name === "profile") && dash && config && (
        <Onboarding phone={dash.phone} me={dash.me} center={config.seedCenter} editing={screen.name === "profile"} onCancel={home}
          onDone={async () => { await refresh(); setScreen({ name: "home" }); }} />
      )}
      {screen.name === "home" && dash?.me && config && (
        <Home initial={dash} config={config} onService={(service) => setScreen({ name: "describe", service })}
          onOpenRequest={(id) => setScreen({ name: "request", id })} onProfile={() => setScreen({ name: "profile" })}
          onSignOut={() => { setHelperToken(null); setDash(null); setScreen({ name: "auth" }); }} />
      )}
      {screen.name === "describe" && dash?.me && config && (
        <Describe service={screen.service} me={dash.me} center={config.seedCenter} onBack={home} onCreated={(id) => setScreen({ name: "request", id })} />
      )}
      {screen.name === "request" && <ServiceRequestView id={screen.id} onClose={home} />}
    </PhoneShell>
  );
}

// ─── Sign in ───────────────────────────────────────────────────────────────────────────────────────────────

function AuthScreen({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col bg-navy-gradient">
      <Container className="flex flex-1 flex-col items-center justify-center gap-7 px-5 py-10">
        <div className="animate-slide-up flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-[1.75rem] bg-violet text-white card-shadow-lg"><Logo size={42} /></div>
          <div>
            <h1 className="font-display text-5xl font-extrabold tracking-tight text-ink">Sahaya</h1>
            {/* The tagline is the promise, so it gets the display italic — the one flourish on this screen. */}
            <p className="mt-1 font-display text-lg font-bold text-ink display-italic">Trusted Help, Right Around You</p>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-mist">
            Plumbers, electricians, carpenters and more from your own neighbourhood — and a way to earn from your own skills.
          </p>
        </div>
        <div className="card-shadow-lg w-full max-w-md rounded-[1.75rem] bg-surface p-6">
          <h2 className="font-display text-xl font-extrabold text-ink">Sign in or create your account</h2>
          <p className="mb-4 mt-1 text-sm text-mist">We&apos;ll text you a 6-digit code. New here? You&apos;ll set up your profile next.</p>
          <OtpForm onDone={() => onDone()} cta="Continue" />
        </div>
      </Container>
    </div>
  );
}

// ─── Profile: details, services with price ranges, ID proof ─────────────────────────────────────────────────

function Onboarding({ phone, me, center, editing, onDone, onCancel }: {
  phone: string; me: Helper | null; center: LatLng; editing: boolean; onDone: () => void; onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const p = me?.profile;
  const [name, setName] = useState(me?.name ?? "");
  const [profile, setProfile] = useState<Record<keyof UserProfile, string>>({
    age: p?.age ? String(p.age) : "", bloodGroup: p?.bloodGroup ?? "", address: p?.address ?? "", medicalNotes: p?.medicalNotes ?? "",
    emergencyContactName: p?.emergencyContactName ?? "", emergencyContactPhone: p?.emergencyContactPhone ?? "",
  });
  const [offered, setOffered] = useState<Service[]>((me?.skills ?? []).filter((s): s is Service => (SERVICES as readonly string[]).includes(s)));
  const [rates, setRates] = useState<Partial<Record<Service, { min: string; max: string }>>>(() => {
    const o: Partial<Record<Service, { min: string; max: string }>> = {};
    for (const [k, v] of Object.entries(me?.rates ?? {})) if (v) o[k as Service] = { min: String(v.min), max: String(v.max) };
    return o;
  });
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<LanguageCode>(languageOf(me?.language).code);
  const [tools, setTools] = useState<Tool[]>(me?.toolsOnHand ?? []);
  const [available, setAvailable] = useState(me ? me.onDuty : true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof UserProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setProfile({ ...profile, [k]: e.target.value });
  const toggle = (s: Service) => setOffered((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const rateErrors = offered.filter((s) => {
    const r = rates[s];
    const min = Number(r?.min), max = Number(r?.max);
    return !r || r.min === "" || r.max === "" || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 100000 || min > max;
  });

  const save = async () => {
    setBusy(true); setMsg(null);
    // Keep non-service skills the person already had (older profiles); services come from this form.
    const otherSkills = (me?.skills ?? []).filter((s) => !(SERVICES as readonly string[]).includes(s));
    const rateBody: Partial<Record<Skill, RateRange>> = {};
    for (const s of offered) rateBody[s] = { min: Number(rates[s]!.min), max: Number(rates[s]!.max) };
    const r = await api<{ token?: string; helper: Helper }>("/api/helpers", {
      body: { name, phone, language, skills: [...otherSkills, ...offered], rates: rateBody, toolsOnHand: tools.filter((t) => offered.some((s) => SERVICE_TOOLS[s].includes(t))),
        profile: { ...profile, age: profile.age ? Number(profile.age) : null } },
    });
    if (!r.ok) { setBusy(false); setMsg(`Please check your details (${r.error.replace(/_/g, " ")}).`); setStep(0); return; }
    if (r.data.token) setHelperToken(r.data.token);
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch("/api/me/id-proof", { method: "POST", body: fd, headers: { "x-resq-session": getHelperToken() ?? "none" } });
      if (!up.ok) {
        const e = (await up.json().catch(() => ({}))) as { error?: string };
        setBusy(false);
        setMsg(e.error === "file_type_invalid" ? "ID proof must be a JPG, PNG, WEBP or PDF." : e.error === "file_size_invalid" ? "ID proof must be under 5 MB." : "Could not upload the ID proof.");
        setStep(1);
        return;
      }
    }
    const loc = await whereAmI(center);
    await api("/api/helpers", { method: "PATCH", body: { onDuty: offered.length > 0 && available, location: loc.at } });
    setBusy(false);
    onDone();
  };

  const input = "mt-1 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-base font-normal outline-none focus:ring-2 focus:ring-resq-red/30";
  const steps = ["Your details", "Offer your skills", "Done"];
  return (
    <>
      <div className="bg-navy-gradient">
        <Container><NavBar title={editing ? "Edit profile" : "Set up your profile"} onBack={editing ? onCancel : step > 0 ? () => setStep(step - 1) : undefined} light /></Container>
        <ol className="mx-auto flex max-w-3xl gap-2 px-5 pb-5">
          {steps.map((t, i) => (
            <li key={t} className="flex-1">
              <div className={`h-1.5 rounded-full ${i <= step ? "bg-violet" : "bg-hairline"}`} />
              <p className={`mt-1.5 text-xs ${i === step ? "font-bold text-ink" : "text-mist"}`}>{i + 1}. {t}</p>
            </li>
          ))}
        </ol>
      </div>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-5">
        {step === 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <p className="text-sm text-resq-slate sm:col-span-2">Signed in as <strong>{phone}</strong>. Your details are shared only with the person on the other side of a job you both agreed to.</p>
            <div className="sm:col-span-2">
              <p className="text-sm font-semibold text-resq-navy">Your language</p>
              <LanguagePicker value={language} onChange={setLanguage} className="mt-2" />
              <LanguageNote code={language} />
            </div>
            <label className="text-sm font-semibold text-resq-navy sm:col-span-2">Full name *<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" className={input} /></label>
            <label className="text-sm font-semibold text-resq-navy">Age<input type="number" inputMode="numeric" min={1} max={120} value={profile.age} onChange={set("age")} className={input} /></label>
            <label className="text-sm font-semibold text-resq-navy">Blood group <span className="font-normal text-resq-slate">(for medical help)</span>
              <select value={profile.bloodGroup} onChange={set("bloodGroup")} className={input}><option value="">Don&apos;t know</option>{BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}</select>
            </label>
            <label className="text-sm font-semibold text-resq-navy sm:col-span-2">Address / area<input value={profile.address} onChange={set("address")} maxLength={200} autoComplete="street-address" placeholder="e.g. Near Karicode junction, Kollam" className={input} /></label>
            <label className="text-sm font-semibold text-resq-navy sm:col-span-2">Health notes <span className="font-normal text-resq-slate">(optional, shared with a doctor or nurse you book)</span><textarea value={profile.medicalNotes} onChange={set("medicalNotes")} maxLength={300} rows={2} className={`${input} py-3`} /></label>
            <label className="text-sm font-semibold text-resq-navy">Alternate contact name<input value={profile.emergencyContactName} onChange={set("emergencyContactName")} maxLength={60} className={input} /></label>
            <label className="text-sm font-semibold text-resq-navy">Alternate contact phone<input type="tel" value={profile.emergencyContactPhone} onChange={set("emergencyContactPhone")} className={input} /></label>
            {msg && <p role="alert" className="text-sm font-medium text-resq-red sm:col-span-2">{msg}</p>}
            <button onClick={() => (name.trim() ? setStep(1) : setMsg("Please enter your name."))} className="min-h-14 rounded-2xl bg-resq-red font-display text-lg font-bold text-white sm:col-span-2">Next</button>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="font-display text-lg font-bold text-resq-navy">Earn by offering your skills <span className="text-sm font-normal text-resq-slate">(optional)</span></h2>
            <p className="mb-3 text-sm text-resq-slate">Pick what you do and what you charge. Neighbours see your price range before they book. Skip this if you only want to hire help.</p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {SERVICES.map((s) => {
                const m = SKILL_META[s], on = offered.includes(s);
                return (
                  <button key={s} onClick={() => toggle(s)} aria-pressed={on} style={on ? { borderColor: m.color } : undefined}
                    className={`flex min-h-14 items-center gap-2.5 rounded-2xl border-2 bg-white p-3 text-left ${on ? "shadow-md" : "border-slate-100"}`}>
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: m.bg, color: m.color }}>{m.icon}</div>
                    <span className="text-sm font-semibold text-resq-navy">{m.label}</span>
                  </button>
                );
              })}
            </div>

            {offered.length > 0 && (
              <>
                <h3 className="mb-2 mt-6 font-display font-bold text-resq-navy">Your price range (₹ per visit)</h3>
                <div className="space-y-2">
                  {offered.map((s) => (
                    <div key={s} className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 card-shadow">
                      <span className="w-36 text-sm font-semibold text-resq-navy">{SKILL_META[s].label}</span>
                      <label className="flex items-center gap-1 text-sm text-resq-slate">₹<input aria-label={`${SKILL_META[s].label} minimum`} type="number" inputMode="numeric" min={0} value={rates[s]?.min ?? ""} placeholder="min"
                        onChange={(e) => setRates({ ...rates, [s]: { min: e.target.value, max: rates[s]?.max ?? "" } })} className="min-h-11 w-24 rounded-lg border border-slate-200 px-2 text-resq-navy" /></label>
                      <span className="text-resq-slate">to</span>
                      <label className="flex items-center gap-1 text-sm text-resq-slate">₹<input aria-label={`${SKILL_META[s].label} maximum`} type="number" inputMode="numeric" min={0} value={rates[s]?.max ?? ""} placeholder="max"
                        onChange={(e) => setRates({ ...rates, [s]: { min: rates[s]?.min ?? "", max: e.target.value } })} className="min-h-11 w-24 rounded-lg border border-slate-200 px-2 text-resq-navy" /></label>
                      {rateErrors.includes(s) && <span className="text-xs text-resq-red">Enter whole rupees, min ≤ max</span>}
                    </div>
                  ))}
                </div>

                <h3 className="mb-1 mt-6 font-display font-bold text-resq-navy">Tools you carry</h3>
                <p className="mb-2 text-sm text-resq-slate">Jobs that need these tools are matched to you first, and the customer knows you&apos;ll come prepared.</p>
                <div className="flex flex-wrap gap-2">
                  {[...new Set(offered.flatMap((s) => SERVICE_TOOLS[s]))].map((t) => {
                    const on = tools.includes(t);
                    return (
                      <button key={t} onClick={() => setTools(on ? tools.filter((x) => x !== t) : [...tools, t])} aria-pressed={on}
                        className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors ${on ? "bg-ink text-white" : "bg-surface text-mist card-shadow"}`}>
                        {on && <Icon.Check size={14} />}{TOOL_LABELS[t]}
                      </button>
                    );
                  })}
                </div>

                <h3 className="mb-1 mt-6 font-display font-bold text-resq-navy">Verify your identity</h3>
                <p className="mb-2 text-sm text-resq-slate">Upload a government ID (Aadhaar, driving licence, voter ID) or a professional licence. An admin checks it and you get the <strong>ID verified</strong> badge, which neighbours trust more.</p>
                <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-4">
                  {me?.idProof && !file && <div className="mb-2 flex items-center gap-2 text-sm text-resq-navy"><VerifiedBadge verified={me.idProof.status === "verified"} pending={me.idProof.status === "pending"} /><span className="truncate">{me.idProof.fileName}</span>{me.idProof.status === "rejected" && <span className="text-resq-red">Rejected{me.idProof.note ? `: ${me.idProof.note}` : ""}. Upload again.</span>}</div>}
                  <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="ID proof" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-resq-slate file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-resq-navy file:px-4 file:font-semibold file:text-white" />
                  <p className="mt-2 text-xs text-resq-slate">JPG, PNG, WEBP or PDF, up to 5 MB. Visible only to Sahaya admins.</p>
                </div>
              </>
            )}
            {msg && <p role="alert" className="mt-3 text-sm font-medium text-resq-red">{msg}</p>}
            <button onClick={() => (rateErrors.length ? setMsg("Please set a price range for every service you offer.") : (setMsg(null), setStep(2)))}
              className="mt-6 min-h-14 w-full rounded-2xl bg-resq-red font-display text-lg font-bold text-white">{offered.length ? "Next" : "Skip, I only want to hire help"}</button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="card-shadow rounded-2xl bg-white p-5">
              <p className="font-display text-lg font-bold text-resq-navy">{name}</p>
              <p className="text-sm text-resq-slate">{phone}{profile.address ? ` · ${profile.address}` : ""}</p>
              {offered.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {offered.map((s) => <li key={s} className="flex justify-between text-sm"><span className="font-semibold text-resq-navy">{SKILL_META[s].label}</span><span className="text-resq-slate">₹{rates[s]?.min}–₹{rates[s]?.max}</span></li>)}
                </ul>
              ) : <p className="mt-3 text-sm text-resq-slate">You can hire help. Add skills any time to start earning.</p>}
              {offered.length > 0 && <p className="mt-3 text-xs text-resq-slate">{file ? "ID proof will be uploaded for review." : me?.idProof ? "ID proof already on file." : "No ID proof yet: you can still accept jobs, but without the verified badge."}</p>}
            </div>
            {offered.length > 0 && (
              <button onClick={() => setAvailable(!available)} aria-pressed={available}
                className={`flex min-h-16 w-full items-center justify-between rounded-2xl px-5 text-left ${available ? "bg-resq-green text-white" : "border-2 border-slate-200 bg-white text-resq-navy"}`}>
                <div><p className="font-display text-lg font-bold">Available for work</p><p className={`text-xs ${available ? "text-white/85" : "text-mist"}`}>Nearby requests for your services reach you instantly.</p></div>
                <div className={`flex h-8 w-14 items-center rounded-full p-1 ${available ? "justify-end bg-white/30" : "justify-start bg-slate-200"}`}><div className="h-6 w-6 rounded-full bg-white shadow" /></div>
              </button>
            )}
            <button onClick={save} disabled={busy} className="min-h-14 w-full rounded-2xl bg-resq-red font-display text-lg font-bold text-white disabled:opacity-60">{busy ? "Saving…" : editing ? "Save profile" : "Start using Sahaya"}</button>
          </div>
        )}
      </main>
    </>
  );
}

// ─── Home ──────────────────────────────────────────────────────────────────────────────────────────────────

function Home({ initial, config, onService, onOpenRequest, onProfile, onSignOut }: {
  initial: Dashboard; config: Config; onService: (s: Service) => void; onOpenRequest: (id: string) => void; onProfile: () => void; onSignOut: () => void;
}) {
  const tok = getHelperToken() ?? "none";
  const { data, connected, setData } = useSnapshot<Dashboard>(`/api/dashboard/stream?s=${encodeURIComponent(tok)}`, "/api/dashboard", { "x-resq-session": tok });
  const dash = data ?? initial;
  const me = dash.me!;
  const isProvider = me.skills.some((s) => (SERVICES as readonly string[]).includes(s));
  const beacon = useLocationBeacon(true, config.seedCenter);
  const [summary, setSummary] = useState<ServiceSummary[] | null>(null);
  const [open, setOpen] = useState<FeedItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Held locally so the header switches the moment it is tapped; the server copy is the source of truth on reload.
  const [lang, setLang] = useState<LanguageCode>(languageOf(me.language).code);
  const seen = useRef<Set<string>>(new Set(initial.feed.map((f) => f.request.id)));
  const pos = useRef<LatLng | null>(me.location);
  pos.current = me.location ?? pos.current;

  const reload = useCallback(async () => { const r = await api<Dashboard>("/api/dashboard"); if (r.ok) setData(r.data); }, [setData]);
  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);

  // What's available nearby (counts + price ranges per service).
  const at = me.location ?? config.seedCenter;
  useEffect(() => {
    const load = () => api<{ services: ServiceSummary[] }>(`/api/services?lat=${at.lat}&lng=${at.lng}`).then((r) => r.ok && setSummary(r.data.services));
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [at.lat, at.lng]);

  // New request for me → sound + tab title.
  useEffect(() => {
    const fresh = dash.feed.filter((f) => !seen.current.has(f.request.id));
    if (fresh.length) { beep(); try { navigator.vibrate?.([250, 100, 250]); } catch { /* unsupported */ } }
    fresh.forEach((f) => seen.current.add(f.request.id));
    document.title = dash.feed.length ? `(${dash.feed.length}) New job nearby · Sahaya` : "Sahaya";
  }, [dash.feed]);

  // The request someone is reading was taken or closed meanwhile → close it and say so.
  useEffect(() => {
    if (open && !dash.feed.some((f) => f.request.id === open.request.id)) { setOpen(null); setToast("That request is no longer open: someone else took it or it was cancelled."); }
  }, [dash.feed, open]);

  // On a job: stream position every 3 s (simulated travel in demo mode) so the customer sees you coming.
  const activeId = dash.active?.request.id ?? null;
  const tLat = dash.active?.request.location?.lat ?? null, tLng = dash.active?.request.location?.lng ?? null;
  useEffect(() => {
    if (!activeId || tLat === null || tLng === null) return;
    const target = { lat: tLat, lng: tLng };
    const t = setInterval(async () => {
      let next: LatLng | null = null;
      if (beacon.source === "gps") next = await getPosition(3000);
      else if (pos.current && distanceKm(pos.current, target) > 0.005) next = stepToward(pos.current, target, 0.06);
      if (next) { pos.current = next; await api("/api/me/location", { body: { location: next, source: beacon.source ?? "demo" } }); }
    }, 3000);
    return () => clearInterval(t);
  }, [activeId, tLat, tLng, beacon.source]);

  const toggleAvailable = async () => {
    const r = await api<{ helper: Helper }>("/api/helpers", { method: "PATCH", body: { onDuty: !me.onDuty } });
    if (r.ok) setData({ ...dash, me: r.data.helper });
  };
  const accept = async (f: FeedItem) => {
    const r = await api<{ ok: boolean; reason?: string }>(`/api/requests/${f.request.id}/accept`, { method: "POST" });
    setOpen(null);
    setToast(r.ok ? `Job accepted. ${f.request.requesterName ?? "The customer"} can now see your details and call you.`
      : r.data.reason === "already_matched" ? "Someone else already accepted this job." : r.data.reason === "busy" ? "Finish your current job first." : "Could not accept that job.");
    void reload();
  };
  const notNow = async (f: FeedItem) => { await api(`/api/requests/${f.request.id}/decline`, { method: "POST" }); setOpen(null); void reload(); };
  // Closing the job. On a paid service the charge is already stored (ActiveJob posted it first), so the
  // confirmation repeats the server's own figures rather than telling anyone to collect cash at the door.
  const done = async (summary: DoneSummary) => {
    if (!dash.active) return;
    const r = await api(`/api/requests/${dash.active.request.id}`, { method: "PATCH", body: { action: "resolve" } });
    setToast(!r.ok ? "Could not close that job. Try again."
      : summary ? `Job done. ${summary.grossPretty} is now on ${dash.active.request.requesterName ?? "the customer"}'s screen to pay; ${summary.payoutPretty} reaches your Sahaya wallet the moment they do.`
      : "Job marked as done.");
    void reload();
  };
  const signOut = async () => { await api("/api/auth/logout", { method: "POST", body: {} }); document.title = "Sahaya"; onSignOut(); };

  return (
    <>
      <div className="bg-navy-gradient">
        <Container className="px-5 pb-6 pt-5 md:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <button onClick={onProfile} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet to-violet-deep font-extrabold text-white">{initials(me.name)}</div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-mist">Hello,</p>
                <h1 className="truncate font-display text-2xl font-extrabold tracking-tight text-ink">{me.name}</h1>
                {isProvider && <div className="mt-1"><VerifiedBadge verified={isVerified(me)} pending={me.idProof?.status === "pending"} /></div>}
              </div>
            </button>
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink card-shadow"><PulsingDot color={connected ? "green" : "red"} />{connected ? "Live" : "…"}</span>
              <LanguagePicker value={lang} onChange={setLang} variant="compact" />
              <button onClick={onProfile} className="min-h-10 rounded-full bg-white px-4 text-xs font-semibold text-ink card-shadow">Profile</button>
              <button onClick={signOut} className="min-h-10 rounded-full bg-white px-4 text-xs font-semibold text-mist card-shadow">Sign out</button>
            </div>
          </div>
        </Container>
      </div>

      {dash.active ? (
        <JobMode active={dash.active} me={me} lang={lang} simulated={beacon.source !== "gps"} waiting={dash.hiddenWhileBusy} toast={toast} onDismissToast={() => setToast(null)} onDone={done} />
      ) : (
        <main className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-5 px-4 py-5 md:px-8 lg:grid-cols-[1.25fr_1fr] lg:items-start">
          <div className="flex flex-col gap-4">
            {toast && <Toast text={toast} onClose={() => setToast(null)} />}
            {dash.myRequest && (
              <button onClick={() => onOpenRequest(dash.myRequest!.id)} className="card-shadow-lg animate-slide-up rounded-2xl border-2 border-resq-cyan bg-white p-5 text-left">
                <div className="flex items-center gap-2"><PulsingDot color="cyan" /><span className="text-xs font-bold uppercase tracking-wider text-resq-cyan">Your request</span>
                  <span className="ml-auto rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-resq-navy">{dash.myRequest.status === "matched" ? "Provider on the way" : "Finding a provider"}</span></div>
                <p className="mt-2 font-display text-lg font-bold text-resq-navy">{dash.myRequest.service ? SKILL_META[dash.myRequest.service].label : "Request"}</p>
                <p className="line-clamp-2 text-sm text-resq-slate">{dash.myRequest.description}</p>
                <p className="mt-2 text-sm font-semibold text-resq-cyan">View live status →</p>
              </button>
            )}
            <section>
              <h2 className="font-display text-[1.5rem] font-extrabold leading-[1.08] tracking-tight text-ink min-[400px]:text-[1.75rem] sm:text-[2.125rem]">
                Whatever&apos;s broken,<br /><span className="display-italic">someone nearby can fix it</span>
              </h2>
              <p className="mb-4 mt-2 text-sm text-mist">Tap a trade. Everyone nearby who does it gets your request at once.</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {SERVICES.map((s) => {
                  const m = SKILL_META[s], sum = summary?.find((x) => x.service === s);
                  return (
                    <button key={s} onClick={() => onService(s)}
                      className="card-shadow group flex min-h-32 flex-col items-start justify-between rounded-[1.75rem] p-4 text-left transition-transform active:scale-[.98]"
                      style={{ background: tintOf(s).tint }}>
                      <div className="flex w-full items-start justify-between">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/70" style={{ color: tintOf(s).dot }}>{m.icon}</div>
                        {/* The circular chevron the reference ends every row with — here it marks the tile as a way in. */}
                        <span aria-hidden className="chev opacity-60 transition-opacity group-hover:opacity-100">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                        </span>
                      </div>
                      <div className="mt-3">
                        <p className="font-display text-base font-extrabold leading-tight" style={{ color: tintOf(s).ink }}>{m.label}</p>
                        <p className="mt-0.5 text-xs font-medium" style={{ color: tintOf(s).ink, opacity: .72 }}>
                          {sum ? (sum.count
                            ? <>{sum.count} nearby · <span className="whitespace-nowrap">₹{sum.minRate}–₹{sum.maxRate}</span></>
                            : "None nearby yet") : "…"}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="flex flex-col gap-3">
            {isProvider ? (
              <>
                {/* A state, not an alarm: a soft card with a small live dot, so "available" does not shout louder
                    than the primary action anywhere else on the screen. */}
                <button onClick={toggleAvailable} aria-pressed={me.onDuty}
                  className={`card-shadow flex min-h-16 items-center justify-between gap-3 rounded-[1.75rem] px-5 text-left transition-colors ${me.onDuty ? "bg-positive-soft" : "bg-surface"}`}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-display font-extrabold text-ink">
                      {me.onDuty && <span aria-hidden className="h-2 w-2 rounded-full bg-positive" />}
                      {me.onDuty ? "Available for work" : "Not taking jobs"}
                    </p>
                    <p className="mt-0.5 text-xs text-mist">{me.onDuty ? "Nearby requests reach you" : me.availabilityPausedAt ? `Paused at ${fmtTime(me.availabilityPausedAt)} after you asked for help · tap when you're free` : "Tap to receive requests"}</p>
                  </div>
                  <div className={`flex h-7 w-12 flex-none items-center rounded-full p-1 transition-colors ${me.onDuty ? "justify-end bg-positive" : "justify-start bg-hairline"}`}><div className="h-5 w-5 rounded-full bg-white shadow-sm" /></div>
                </button>
                <BeaconChip paused={beacon.paused} ago={beacon.ago} source={beacon.source} onToggle={(p) => void beacon.setPaused(p)} />
                <div className="mt-2 flex items-end justify-between">
                  <div><h2 className="font-display text-xl font-extrabold tracking-tight text-ink">Job requests for you</h2>
                    <p className="text-xs text-resq-slate">Within {dash.radiusKm} km for {me.skills.filter((s) => (SERVICES as readonly string[]).includes(s)).map((s) => SKILL_META[s].label).join(", ")}</p></div>
                  <Badge variant={dash.feed.length ? "emergency" : "default"}>{dash.feed.length}</Badge>
                </div>
                {dash.feed.map((f) => <JobCard key={f.request.id} f={f} onOpen={() => setOpen(f)} />)}
                {me.onDuty && dash.feed.length === 0 && (
                  <div className="card-shadow rounded-2xl border border-slate-100 bg-white p-6 text-center">
                    <Icon.Bell size={26} className="mx-auto text-resq-slate" />
                    <p className="mt-2 font-display font-semibold text-resq-navy">No job requests right now</p>
                    <p className="mt-1 text-sm text-resq-slate">Keep this open: new requests appear here instantly with a sound.</p>
                  </div>
                )}
                {!me.onDuty && (
                  <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                    You&apos;re not taking jobs.{dash.hiddenWhileUnavailable ? ` ${dash.hiddenWhileUnavailable} request${dash.hiddenWhileUnavailable > 1 ? "s are" : " is"} waiting nearby.` : ""}
                    <button onClick={toggleAvailable} className="mt-3 min-h-12 w-full rounded-xl bg-resq-green font-semibold text-white">I&apos;m available for work</button>
                  </div>
                )}
              </>
            ) : (
              <div className="card-shadow rounded-2xl border border-slate-100 bg-gradient-to-br from-white to-resq-green-light p-5">
                <p className="font-display text-lg font-bold text-resq-navy">Earn from your skills</p>
                <p className="mt-1 text-sm text-resq-slate">Plumber, electrician, nurse, cleaner…? Set your price range, verify your ID and get job requests from neighbours.</p>
                <button onClick={onProfile} className="mt-3 min-h-12 w-full rounded-xl bg-resq-green font-semibold text-white">Start offering a service</button>
              </div>
            )}
          </section>
        </main>
      )}
      {open && <JobSheet f={open} me={me} onClose={() => setOpen(null)} onAccept={() => accept(open)} onDecline={() => notNow(open)} />}
    </>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="animate-fade-in flex items-center gap-2 rounded-2xl bg-resq-navy px-4 py-3 text-sm font-semibold text-white">
      <Icon.Check size={16} />{text}<button onClick={onClose} aria-label="Dismiss" className="ml-auto flex h-9 w-9 items-center justify-center"><Icon.X size={16} /></button>
    </div>
  );
}

function JobCard({ f, onOpen }: { f: FeedItem; onOpen: () => void }) {
  const r = f.request;
  const m = r.service ? SKILL_META[r.service] : null;
  return (
    <button onClick={onOpen}
      className="card-shadow animate-slide-up w-full rounded-[1.75rem] p-4 text-left transition-transform active:scale-[.99]"
      style={{ background: tintOf(r.service).tint }}>
      <div className="flex items-center gap-2">
        {m && <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/70" style={{ color: tintOf(r.service).dot }}>{m.icon}</span>}
        <span className="font-display font-extrabold" style={{ color: tintOf(r.service).ink }}>{m?.label ?? "Job"}</span>
        <span className="ml-auto text-xs font-medium" style={{ color: tintOf(r.service).ink, opacity: .7 }}>{fmtTime(r.createdAt)}</span>
        <span aria-hidden className="chev"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg></span>
      </div>
      <p className="mt-2 text-sm text-ink"><strong className="font-bold">{r.requesterName ?? "A neighbour"}</strong> · {fmtDistance(f.distanceKm)} away</p>
      {f.aiMatch && <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-resq-green-light px-2 py-0.5 text-xs font-bold text-resq-green"><Icon.Check size={12} />Matched for you: you have the tools</p>}
      {r.scope && <p className="mt-1 text-sm font-semibold text-resq-navy">{r.scope.parsedTitle} · ~{r.scope.estimatedTimeMinutes} min</p>}
      <p className="line-clamp-2 text-sm text-ink/70">“{r.description}”</p>
      <p className="mt-2 rounded-full bg-white/60 px-3 py-1.5 text-xs text-ink/75">Your rate: <strong className="font-bold text-ink">{fmtRate(f.myRate)}</strong>{r.scope?.requiredTools.length ? ` · you have ${f.toolsHave.length}/${r.scope.requiredTools.length} tools` : ""}{f.photoCount ? ` · ${f.photoCount} photo${f.photoCount > 1 ? "s" : ""} after you accept` : ""}</p>
    </button>
  );
}

function JobSheet({ f, me, onClose, onAccept, onDecline }: { f: FeedItem; me: Helper; onClose: () => void; onAccept: () => void; onDecline: () => void }) {
  const r = f.request;
  const m = r.service ? SKILL_META[r.service] : null;
  const [busy, setBusy] = useState(false);
  const markers: MapMarker[] = [];
  if (r.location) markers.push({ id: "r", at: r.location, color: "#DC2626", kind: "target", label: "Job" });
  if (me.location) markers.push({ id: "me", at: me.location, color: "#16A34A", kind: "you", label: "You", pulse: false });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-resq-navy-dark/60 backdrop-blur-sm md:items-center" role="dialog" aria-modal="true" aria-labelledby="job-title" onClick={onClose}>
      <div className="animate-slide-up max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white shadow-2xl md:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-navy-gradient px-5 py-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-bold text-mist">New job request</p>
              <h2 id="job-title" className="mt-1 font-display text-2xl font-bold">{m?.label ?? "Job"}</h2>
              <p className="text-sm text-mist">{fmtDistance(f.distanceKm)} from you · {fmtTime(r.createdAt)}</p>
            </div>
            <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/15"><Icon.X size={18} /></button>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-resq-navy">“{r.description}”</p>
          {r.scope && (
            <div className="rounded-xl border border-resq-cyan/30 bg-resq-cyan-light p-3">
              <p className="text-xs font-bold uppercase tracking-wider text-resq-cyan">AI job breakdown</p>
              <p className="mt-1 text-sm font-semibold text-resq-navy">{r.scope.parsedTitle} · ~{r.scope.estimatedTimeMinutes} min · {r.scope.skillLevelRequired}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.scope.requiredTools.map((t) => {
                  const have = f.toolsHave.includes(t);
                  return <span key={t} className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-semibold ${have ? "bg-resq-green-light text-resq-green" : "bg-white text-resq-slate"}`}>{have ? <Icon.Check size={12} /> : null}{TOOL_LABELS[t]}</span>;
                })}
              </div>
              {f.photoCount > 0 && <p className="mt-2 text-xs text-resq-slate">{f.photoCount} photo{f.photoCount > 1 ? "s" : ""} and the customer&apos;s answers unlock when you accept.</p>}
            </div>
          )}
          <PersonDetails r={r} />
          <p className="rounded-xl bg-resq-green-light p-3 text-sm text-resq-navy">Your listed rate for this service: <strong>{fmtRate(f.myRate)}</strong></p>
          {r.location && <div className="overflow-hidden rounded-2xl"><LiveMap center={r.location} radiusKm={Math.max(0.4, (f.distanceKm ?? 0.5) * 1.4)} markers={markers} height={170} route={me.location ? [me.location, r.location] : undefined} /></div>}
          <p className="text-xs text-resq-slate">If you accept, {r.requesterName ?? "the customer"} sees your name, phone, rating and price range, and you&apos;re guided to their location.</p>
          <div className="grid grid-cols-2 gap-3">
            <button disabled={busy} onClick={() => { setBusy(true); onAccept(); }} className="flex min-h-16 flex-col items-center justify-center rounded-2xl bg-success-gradient font-display text-lg font-bold text-white shadow-lg disabled:opacity-60"><Icon.Check size={22} />Accept job</button>
            <button disabled={busy} onClick={() => { setBusy(true); onDecline(); }} className="flex min-h-16 flex-col items-center justify-center rounded-2xl border-2 border-slate-200 font-display text-lg font-bold text-resq-slate disabled:opacity-60"><Icon.X size={22} />Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// On a job: only the customer's details; other requests wait in a locked tab until "Mark as done".
function JobMode({ active, me, lang, simulated, waiting, toast, onDismissToast, onDone }: {
  active: NonNullable<Dashboard["active"]>; me: Helper; lang: LanguageCode; simulated: boolean; waiting: number; toast: string | null;
  onDismissToast: () => void; onDone: (summary: DoneSummary) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"job" | "others">("job");
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 md:px-8">
      <div role="tablist" aria-label="Your work" className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-slate-200/70 p-1">
        <button role="tab" aria-selected={tab === "job"} onClick={() => setTab("job")} className={`min-h-12 rounded-xl text-sm font-semibold ${tab === "job" ? "bg-white text-resq-navy shadow" : "text-resq-slate"}`}>Current job</button>
        <button role="tab" aria-selected={tab === "others"} onClick={() => setTab("others")} className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-sm font-semibold ${tab === "others" ? "bg-white text-resq-navy shadow" : "text-resq-slate"}`}>
          Other requests<span className="rounded-full bg-slate-300/80 px-2 py-0.5 text-xs text-resq-navy">{waiting}</span>
        </button>
      </div>
      {toast && <div className="mb-4"><Toast text={toast} onClose={onDismissToast} /></div>}
      {tab === "job" ? (
        <>
          <ActiveJob r={active.request} mapsUrl={active.mapsUrl} me={me.location} simulated={simulated} myRate={rateFor(me, active.request.service)} onDone={onDone} />
          <VoiceNotes requestId={active.request.id} myLanguage={lang} className="mt-4" />
        </>
      ) : (
        <section className="card-shadow rounded-2xl border border-slate-100 bg-white p-6 text-center">
          <Icon.Clock size={26} className="mx-auto text-resq-slate" />
          <p className="mt-2 font-display text-lg font-bold text-resq-navy">Finish your current job first</p>
          <p className="mt-1 text-sm text-resq-slate">{waiting > 0 ? `${waiting} request${waiting > 1 ? "s" : ""} for your services ${waiting > 1 ? "are" : "is"} waiting nearby. ` : ""}They appear here as soon as you tap <strong>Mark as done</strong>.</p>
          <button onClick={() => setTab("job")} className="mt-4 min-h-12 w-full rounded-xl bg-resq-navy font-semibold text-white">Back to {active.request.requesterName ?? "the customer"}</button>
        </section>
      )}
    </main>
  );
}

// ─── Describe the problem (after tapping a service) ─────────────────────────────────────────────────────────

function Describe({ service, me, center, onBack, onCreated }: { service: Service; me: Helper; center: LatLng; onBack: () => void; onCreated: (id: string) => void }) {
  const m = SKILL_META[service];
  const [text, setText] = useState("");
  const [loc, setLoc] = useState<{ at: LatLng; source: "gps" | "demo" } | null>(null);
  const [providers, setProviders] = useState<ProviderPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  // Everything downstream of this box — job scoping, which trade is picked, what providers read — works in
  // English. So someone who speaks Malayalam is transcribed in Malayalam, then pivoted to English here, once.
  const myLang = languageOf(me.language).code;
  const [spoken, setSpoken] = useState<string | null>(null);   // their own words, kept on screen
  const [translating, setTranslating] = useState(false);
  const [translateNote, setTranslateNote] = useState<string | null>(null);

  const pivotToEnglish = async (heard: string) => {
    if (myLang === "en-IN") { setText(heard); return; }
    setSpoken(heard);
    setText(heard);
    setTranslating(true);
    setTranslateNote(null);
    try {
      const r = await api<{ text: string; source: string }>("/api/translate", { body: { text: heard, from: myLang, to: "en-IN" } });
      if (r.ok && (r.data.source === "sarvam" || r.data.source === "ollama")) {
        setText(r.data.text);
        setTranslateNote("Translated to English for the provider. Check it and edit if it is wrong.");
      } else {
        setTranslateNote("Could not translate that — your own words were kept. Edit them or send as they are.");
      }
    } catch {
      setTranslateNote("Could not translate that — your own words were kept.");
    } finally {
      setTranslating(false);
    }
  };

  /**
   * Tap to record, tap again to stop. The clip goes to Sarvam, which transcribes AND translates in one call, so
   * nothing here depends on the browser being able to recognise Malayalam — which is what used to hang.
   */
  const [heardLang, setHeardLang] = useState<string | null>(null);
  const sendClip = async (clip: Blob, secs: number) => {
    setVoiceErr(null);
    setSpoken(null);
    setTranslateNote(null);
    setTranslating(true);
    try {
      const fd = new FormData();
      fd.append("audio", clip, `speech.${(clip.type.split("/")[1] ?? "webm").split(";")[0]}`);
      const res = await fetch("/api/speech", { method: "POST", body: fd, headers: { "x-resq-session": getHelperToken() ?? "none" } });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setVoiceErr(j.error === "speech_not_configured"
          ? "Voice input is not set up on this server. Please type instead."
          : "Could not understand that recording. Try again, or type it.");
        return;
      }
      const data = (await res.json()) as { text: string; detected: string | null; heard: string | null };
      setText(data.text);
      setHeardLang(data.detected);
      if (data.heard) setSpoken(data.heard);   // their own words stay on screen beside the English
      setTranslateNote(`Heard ${secs}s of ${data.detected ? languageLabel(data.detected) : "speech"} and wrote it in English. Check it and edit if it is wrong.`);
    } catch {
      setVoiceErr("Could not send that recording. Try again, or type it.");
    } finally {
      setTranslating(false);
    }
  };

  const recorder = useRecorder({ onClip: (clip, secs) => { void sendClip(clip, secs); }, onError: (e) => setVoiceErr(recorderErrorText(e)) });

  // Only used when the browser cannot record at all; Sarvam is the primary path.
  const speech = useSpeech({
    lang: myLang, fallbackLang: "en-IN", maxMs: 12_000,
    onText: setText,
    onFinal: (heard) => { void pivotToEnglish(heard); },
    onError: (e) => setVoiceErr(speechErrorText(e)),
  });
  const micOn = recorder.supported ? recorder.recording : speech.listening;
  const micSupported = recorder.supported || speech.supported;
  const tapMic = () => {
    setVoiceErr(null); setSpoken(null); setTranslateNote(null); setHeardLang(null);
    if (recorder.supported) recorder.toggle(); else speech.toggle();
  };

  useEffect(() => { void whereAmI(center).then(setLoc); }, [center]);
  useEffect(() => {
    if (!loc) return;
    void api<{ providers: ProviderPreview[] }>(`/api/services?service=${service}&lat=${loc.at.lat}&lng=${loc.at.lng}`).then((r) => r.ok && setProviders(r.data.providers.filter((p) => p.id !== me.id)));
  }, [loc, service, me.id]);

  const submit = async () => {
    if (text.trim().length < 5) { setError("Please describe the problem in a few words."); return; }
    setBusy(true); setError(null);
    const r = await api<RequestView>("/api/requests", { body: { service, description: text.trim(), location: loc?.at ?? me.location ?? null } });
    setBusy(false);
    if (r.ok) onCreated(r.data.request.id); else setError(`Could not send the request (${r.error.replace(/_/g, " ")}).`);
  };
  const rates = (providers ?? []).map((p) => p.rate).filter((r): r is RateRange => !!r);
  return (
    <>
      <div className="bg-navy-gradient">
        <Container><NavBar title={`Book a ${m.label.toLowerCase()}`} onBack={onBack} /></Container>
        {/* The reference opens a detail screen with a full-bleed colour panel carrying the category. Here the
            panel is the trade's own tint, so the screen you land on is visibly the one you tapped. */}
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 md:px-8">
          <div className="flex items-center gap-4 rounded-[1.75rem] p-5" style={{ background: tintOf(service).tint }}>
            <div className="flex h-14 w-14 flex-none items-center justify-center rounded-2xl bg-white/70" style={{ color: tintOf(service).dot }}>{m.icon}</div>
            <div className="min-w-0">
              <p className="font-display text-xl font-extrabold leading-tight" style={{ color: tintOf(service).ink }}>{m.label}</p>
              <p className="mt-0.5 text-sm" style={{ color: tintOf(service).ink, opacity: .78 }}>
                {providers === null ? "Checking who's nearby…" : providers.length
                  ? `${providers.length} nearby${rates.length ? ` · usually ₹${Math.min(...rates.map((r) => r.min))}–₹${Math.max(...rates.map((r) => r.max))}` : ""}`
                  : "Nobody online nearby right now — your request stays open."}
              </p>
            </div>
          </div>
        </div>
      </div>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-5">
        <label htmlFor="what" className="mb-1.5 block font-display text-lg font-bold text-resq-navy">Describe the problem</label>
        <div className="flex items-start gap-3">
          <textarea id="what" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={4} autoFocus
            placeholder={service === "plumber" ? "e.g. Kitchen sink pipe is leaking and water is spreading on the floor" : "What needs to be done, and anything they should bring"}
            className="card-shadow min-h-32 flex-1 rounded-2xl border border-slate-200 bg-white p-4 text-base text-resq-navy outline-none focus:ring-2 focus:ring-resq-red/30" />
          {micSupported && <VoiceMic listening={micOn} onToggle={tapMic} disabled={translating} />}
        </div>
        {micSupported && !micOn && !spoken && !translating && !heardLang && (
          <p className="mt-2 text-xs text-resq-slate">
            Tap the mic and speak in {languageOf(myLang).endonym} — Sahaya writes it in English for the provider.
            {recorder.supported && " Tap it again when you have finished."}
          </p>
        )}
        {micOn && (
          <p className="mt-2 flex items-center gap-2 text-xs font-semibold text-resq-red">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-resq-red" />
            Recording {recorder.recording ? `${recorder.seconds}s` : ""} — tap the mic again to stop
            {recorder.recording && recorder.seconds >= MAX_RECORD_SECONDS - 10 ? ` (stops at ${MAX_RECORD_SECONDS}s)` : ""}
          </p>
        )}
        {translating && (
          <p className="mt-2 flex items-center gap-2 text-xs text-resq-navy"><span className="h-3 w-3 animate-spin rounded-full border-2 border-resq-cyan border-t-transparent" />Writing down what you said…</p>
        )}
        {heardLang && translateNote && !translating && (
          <p className="mt-2 rounded-xl bg-slate-50 p-2.5 text-xs text-resq-slate">{translateNote}</p>
        )}
        {spoken && !translating && (
          <div className="mt-2 rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-resq-slate">You said, in {languageOf(myLang).endonym}:</p>
            <p className="mt-0.5 text-sm text-resq-navy">{spoken}</p>
            {translateNote && <p className="mt-1.5 text-xs text-resq-slate">{translateNote}</p>}
          </div>
        )}
        {voiceErr && <p className="mt-2 rounded-2xl bg-alert-soft p-2.5 text-xs font-medium text-alert">{voiceErr}</p>}

        {providers && providers.length > 0 && (
          <section className="mt-5">
            <h3 className="mb-2 font-display font-semibold text-resq-navy">Who will get your request</h3>
            <ul className="space-y-2">
              {providers.slice(0, 5).map((p) => (
                <li key={p.id} className="card-shadow flex items-center gap-3 rounded-xl bg-white p-3">
                  <div className="flex h-11 w-11 flex-none items-center justify-center rounded-2xl text-sm font-extrabold" style={{ background: tintOf(service).tint, color: tintOf(service).ink }}>{initials(p.name)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-resq-navy">{p.name}<Stars rating={p.rating} /><VerifiedBadge verified={p.verified} /></p>
                    <p className="text-xs text-resq-slate">{fmtDistance(p.distanceKm)} away · {fmtRate(p.rate)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="mt-4 flex items-center gap-1 text-xs text-resq-slate"><Icon.MapPin size={12} />{loc ? (loc.source === "gps" ? "Using your GPS location" : "Demo location near TKMCE (this device's GPS isn't in the demo area)") : "Getting your location…"}. Shared only with the provider who accepts.</p>
        {error && <p role="alert" className="mt-3 rounded-xl bg-resq-red-light p-3 text-sm font-medium text-resq-red">{error}</p>}
        <button onClick={() => setAnalysing(true)} disabled={busy || text.trim().length < 5}
          className={`mt-4 flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl font-display text-xl font-bold ${text.trim().length >= 5 ? "bg-resq-red text-white shadow-lg" : "cursor-not-allowed bg-slate-200 text-slate-400"}`}>
          <Icon.Activity size={20} />Analyse &amp; request
        </button>
        <p className="mt-1.5 text-center text-xs text-resq-slate">Local AI works out the tools and time, and which photos help the {m.label.toLowerCase()} come prepared.</p>
        <button onClick={submit} disabled={busy || text.trim().length < 5} className="mt-2 min-h-12 w-full rounded-xl text-sm font-semibold text-resq-slate underline disabled:opacity-50">
          {busy ? "Sending…" : "Skip the analysis and send now"}
        </button>
        {analysing && (
          <TaskScopeModal service={service} description={text.trim()} location={loc?.at ?? me.location ?? null}
            onClose={() => setAnalysing(false)} onSent={onCreated} onSendWithoutAI={() => { setAnalysing(false); void submit(); }} />
        )}
      </main>
    </>
  );
}
