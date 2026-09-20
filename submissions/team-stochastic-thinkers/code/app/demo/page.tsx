"use client";
/* Presenter's launcher: opens phone-sized windows, each with its own identity (requester / helpers / coordinator). */
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Logo } from "@/components/ui";

const W = 400, H = 820;

function open(path: string, slot: number) {
  const left = 20 + slot * (W + 12);
  // noopener → a fresh window with its own sessionStorage (its own identity); ?new=1 clears any copied identity.
  window.open(`${path}${path.includes("?") ? "&" : "?"}new=1`, `_blank`, `popup,noopener,width=${W},height=${H},left=${left},top=40`);
}

export default function DemoPage() {
  const [slot, setSlot] = useState(0);
  const next = () => { const s = slot; setSlot((x) => (x + 1) % 4); return s; };
  const steps = [
    { n: 1, t: "Open 3 user windows", d: "Each window signs in with a different 10-digit number and the 6-digit code (sent by SMS, or shown on screen in offline demo mode)." },
    { n: 2, t: "Make one a provider", d: "In window 1 pick Plumber, set a price range (e.g. ₹350–₹700) and upload any image as an ID proof. Leave “Available for work” on." },
    { n: 3, t: "Book a service", d: "In window 2 tap Plumber, describe the problem (type or tap the mic) and send. You see who will get it, with ratings, badges and prices." },
    { n: 4, t: "Provider gets it live", d: "Window 1 beeps and shows the job under “Job requests for you”. Tap it for the customer's details, then Accept." },
    { n: 5, t: "Call, message, navigate", d: "The customer sees the provider's name, phone, price range and live position; the provider sees the customer and a map. Only one job at a time." },
    { n: 6, t: "Done, pay, rate · admin", d: "Mark as done → the customer sees “Pay in app (coming soon)” and rates. In /ops (coordinator / resq-ops) approve the ID proof: the provider gets the ID verified badge." },
  ];
  return (
    <div className="min-h-dvh bg-navy-gradient px-5 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-resq-red"><Logo size={28} /></div>
          <div><h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Demo launcher</h1><p className="text-sm text-mist">Run the whole community on one laptop: every window is a different person. About 7 minutes.</p></div>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Coordinator", sub: "Admin: coordinator / resq-ops", icon: <Icon.Activity size={22} />, cls: "bg-resq-cyan", path: "/ops", wide: true },
            { label: "User window", sub: "Open 3–4 of these", icon: <Icon.User size={22} />, cls: "bg-resq-green", path: "/" },
          ].map((b) => (
            <button key={b.label} onClick={() => (b.wide ? window.open("/ops", "_blank", "noopener") : open(b.path, next()))}
              className="rounded-2xl border border-white/15 bg-white/5 p-5 text-left transition-colors hover:bg-white/10">
              <div className={`mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-white ${b.cls}`}>{b.icon}</div>
              <p className="font-display text-lg font-extrabold text-ink">Open {b.label.toLowerCase()}</p>
              <p className="text-sm text-mist">{b.sub}</p>
            </button>
          ))}
          <button onClick={() => { open("/", 0); open("/", 1); open("/", 2); open("/", 3); }}
            className="rounded-2xl border-2 border-resq-red bg-resq-red/20 p-5 text-left transition-colors hover:bg-resq-red/30">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-resq-red text-white"><Icon.Expand size={22} /></div>
            <p className="font-display text-lg font-extrabold text-ink">Open 4 users</p>
            <p className="text-sm text-mist">4 users side by side</p>
          </button>
        </div>
        <p className="mt-3 text-xs text-mist">If nothing opens, allow pop-ups for this site. On phones, just open the helper and requester pages on different devices.</p>

        <ol className="mt-10 grid gap-3 md:grid-cols-2">
          {steps.map((s) => (
            <li key={s.n} className="flex gap-4 rounded-2xl bg-white p-5 card-shadow">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-resq-navy font-display font-bold text-white">{s.n}</span>
              <div><p className="font-display font-bold text-resq-navy">{s.t}</p><p className="mt-1 text-sm text-resq-slate">{s.d}</p></div>
            </li>
          ))}
        </ol>

        <div className="mt-8 rounded-2xl border border-amber-300/40 bg-amber-50/10 p-5 text-sm text-amber-100">
          <p className="font-semibold text-amber-200">Why windows, not tabs?</p>
          <p className="mt-1">Each window keeps its own identity in session storage, so one browser can be a requester and several helpers at once. A duplicated tab copies that identity; open new ones from here instead.</p>
        </div>
        <Link href="/" className="card-shadow mt-8 inline-flex min-h-12 items-center gap-2 rounded-full bg-surface px-5 text-sm font-semibold text-ink"><Icon.ChevronLeft size={16} />Back to Sahaya</Link>
      </div>
    </div>
  );
}
