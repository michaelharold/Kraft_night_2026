/* Shared UI ported from the Sahaya Figma Make design. */
import Link from "next/link";
import { Icon } from "./icons";

export function PhoneShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-slate-50 shadow-xl md:max-w-none md:shadow-none">{children}</div>;
}

export function NavBar({ title, onBack, backHref, light = false, action }: {
  title: string; onBack?: () => void; backHref?: string; light?: boolean; action?: React.ReactNode;
}) {
  // `light` once meant "this bar sits on the navy header". The header is bone now, so both variants are ink
  // and the flag only decides whether the bar draws its own white surface.
  const cls = "flex h-12 w-12 items-center justify-center rounded-full text-ink transition-colors hover:bg-black/5";
  return (
    <div className={`flex items-center justify-between px-3 py-2 ${light ? "" : "border-b border-slate-100 bg-white"}`}>
      {onBack ? <button aria-label="Back" onClick={onBack} className={cls}><Icon.ChevronLeft size={22} /></button>
        : backHref ? <Link aria-label="Back" href={backHref} className={cls}><Icon.ChevronLeft size={22} /></Link>
        : <div className="w-12" />}
      <h1 className="font-display text-base font-bold text-ink">{title}</h1>
      <div className="flex min-w-12 justify-end">{action}</div>
    </div>
  );
}

const BADGE = {
  default: "bg-bone text-mist font-semibold",
  emergency: "bg-violet-soft text-violet-deep font-bold",
  success: "bg-positive-soft text-positive font-bold",
  ai: "bg-violet-soft text-violet-deep font-bold",
  warning: "bg-warn-soft text-warn font-bold",
} as const;

export function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: keyof typeof BADGE }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[variant]}`}>{children}</span>;
}

export function ETABadge({ minutes }: { minutes: number }) {
  return (
    <div className="flex items-center gap-1.5 rounded-xl bg-resq-green px-3 py-1.5 text-white">
      <Icon.Clock size={14} />
      <span className="font-mono text-sm font-bold">{minutes} min</span>
    </div>
  );
}

export function PulsingDot({ color = "red" }: { color?: "red" | "green" | "cyan" }) {
  const c = { red: "bg-resq-red", green: "bg-resq-green", cyan: "bg-resq-cyan" }[color];
  return (
    <span className="relative flex h-3 w-3">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${c}`} />
      <span className={`relative inline-flex h-3 w-3 rounded-full ${c}`} />
    </span>
  );
}

export function Call112Bar() {
  return (
    <div className="sticky bottom-0 z-20 flex items-center gap-2 border-t border-slate-200 bg-white/95 px-4 py-2 backdrop-blur">
      <Icon.Phone size={12} className="text-resq-slate" />
      <p className="text-xs text-resq-slate"><span className="font-semibold">Sahaya complements 112.</span> It does not replace it.</p>
      <a href="tel:112" className="ml-auto flex min-h-12 items-center gap-1.5 whitespace-nowrap rounded-xl bg-resq-red px-4 text-sm font-bold text-white">
        <Icon.Phone size={14} />Call 112
      </a>
    </div>
  );
}

export function Countdown({ seconds, total }: { seconds: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (seconds / total) * 100)) : 0;
  const color = pct > 50 ? "#16A34A" : pct > 20 ? "#D97706" : "#DC2626";
  const C = 2 * Math.PI * 24;
  return (
    <div className="relative h-16 w-16" role="timer" aria-label={`${seconds} seconds left`}>
      <svg className="h-full w-full -rotate-90" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r="24" fill="none" stroke="#F1F5F9" strokeWidth="5" />
        <circle cx="28" cy="28" r="24" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} style={{ transition: "stroke-dashoffset 1s linear, stroke .3s" }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-lg font-bold text-resq-navy">{seconds}</div>
    </div>
  );
}

export function ProgressBar({ seconds, total }: { seconds: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (seconds / total) * 100)) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full transition-all duration-1000"
        style={{ width: `${pct}%`, background: pct > 50 ? "#16A34A" : pct > 20 ? "#D97706" : "#DC2626" }} />
    </div>
  );
}

export function TypingDots() {
  return (
    <div className="flex items-center gap-1.5" aria-label="Thinking">
      <div className="typing-dot-1 h-2 w-2 rounded-full bg-resq-cyan" />
      <div className="typing-dot-2 h-2 w-2 rounded-full bg-resq-cyan" />
      <div className="typing-dot-3 h-2 w-2 rounded-full bg-resq-cyan" />
    </div>
  );
}

/**
 * The Sahaya mark: a location pin whose counter is a roof.
 *
 * It replaces a star-and-cross, which read as an ambulance — the right mark for the disaster-response product
 * this used to be, and the wrong one for booking a carpenter. The two ideas here are the whole promise: a place
 * (the pin) and a home (the roof). "Trusted help, right around you."
 *
 * Drawn as one solid silhouette with a single knocked-out counter so it survives being 16px in a browser tab,
 * where anything finer turns to mud. `currentColor` lets it sit on the violet tile or invert on a dark one.
 */
export function Logo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd" clipRule="evenodd" fill="currentColor"
        d="M24 4c-8.837 0-16 6.94-16 15.5C8 30.5 24 44 24 44s16-13.5 16-24.5C40 10.94 32.837 4 24 4Zm0 8.4 8.2 6.7v9.05a1.6 1.6 0 0 1-1.6 1.6h-4.2v-5.9h-4.8v5.9h-4.2a1.6 1.6 0 0 1-1.6-1.6V19.1l8.2-6.7Z"
      />
    </svg>
  );
}

export function BottomNav({ active, guard }: { active: "home" | "helper"; guard?: (href: string) => void }) {
  const items = [
    { id: "home", href: "/", label: "Get help", icon: <Icon.Activity size={22} /> },
    { id: "helper", href: "/helper", label: "I can help", icon: <Icon.Shield size={22} /> },
  ] as const;
  return (
    <nav className="flex justify-around border-t border-slate-100 bg-white px-6 pb-4 pt-2 md:hidden">
      {items.map((i) => (
        <Link key={i.id} href={i.href} onClick={guard && i.href !== "/" ? (e) => { e.preventDefault(); guard(i.href); } : undefined} className={`flex min-h-12 flex-col items-center gap-1 rounded-xl px-4 py-1 ${active === i.id ? "text-resq-red" : "text-resq-slate"}`}>
          {i.icon}<span className="text-xs font-medium">{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");
}

/** Wide-screen navigation (the bottom nav is phone-only). */
export function TopNav({ active, light = true, guard }: { active: "home" | "helper"; light?: boolean; guard?: (href: string) => void }) {
  const items = [{ id: "home", href: "/", label: "Get help" }, { id: "helper", href: "/helper", label: "I can help" }] as const;
  return (
    <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
      {items.map((i) => (
        <Link key={i.id} href={i.href} aria-current={active === i.id ? "page" : undefined}
          onClick={guard && i.href !== "/" ? (e) => { e.preventDefault(); guard(i.href); } : undefined}
          className={`flex min-h-10 items-center whitespace-nowrap rounded-xl px-4 text-sm font-semibold ${active === i.id
            ? (light ? "bg-white/15 text-white" : "bg-resq-navy text-white") : (light ? "text-white/70 hover:text-white" : "text-resq-slate hover:text-resq-navy")}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** Centres page content and caps its width on large screens. */
export function Container({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl ${className}`}>{children}</div>;
}
