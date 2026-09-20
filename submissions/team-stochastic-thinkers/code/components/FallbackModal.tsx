"use client";
/*
 * 3-minute smart fallback (upgrade §6), requester side. When a LIFE_SAFETY request escalates (all 4 waves done or the
 * 3-minute deadline passed, `fallbackAt` set by the server) this opens a full-screen alert dialog with a looping
 * two-tone alarm and ONE big button that calls 112. Once dismissed it never reopens for the same request in this
 * window (sessionStorage, per-window identity like the rest of the app).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { windowStore } from "@/lib/client/api";
import { categoryOf } from "@/lib/policy";
import type { HelpRequest } from "@/lib/types";

const seenKey = (id: string) => `resq_fallback_seen_${id}`;

/** True while the fallback should be in the requester's face: a free life-safety request nobody accepted. */
export function isFallbackDue(r: Pick<HelpRequest, "category" | "status" | "fallbackAt">): boolean {
  if (categoryOf(r) !== "LIFE_SAFETY") return false;
  if (r.status === "escalated") return true;
  return !!r.fallbackAt && (r.status === "searching" || r.status === "triaging");
}

/**
 * Looping two-tone alarm via Web Audio (no audio file). Browsers allow it because the requester already tapped
 * "Ask for help"; if the context still starts suspended it resumes on the next tap or key press.
 * Returns a stop function that is safe to call more than once.
 */
export function startAlarm(): () => void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = new Ctx();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "square";
    gain.gain.value = 0.0001;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    let high = true;
    const step = () => {
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(high ? 960 : 720, t);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
      gain.gain.setValueAtTime(0.16, t + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      high = !high;
    };
    step();
    const timer = setInterval(step, 420);
    const resume = () => { void ctx.resume().catch(() => {}); };
    if (ctx.state === "suspended") resume();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      try { osc.stop(); } catch { /* already stopped */ }
      void ctx.close().catch(() => {});
    };
  } catch { return () => {}; }
}

const CSS = `
@keyframes resq-fallback-ring { 0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, .6); } 100% { box-shadow: 0 0 0 22px rgba(220, 38, 38, 0); } }
.resq-fallback-call { animation: resq-fallback-ring 1.2s ease-out infinite; }
`;

/** Mount with `key={request.id}` so a retried request starts with a fresh (not dismissed) modal. */
export function FallbackModal({ request, onRetry }: { request: HelpRequest; onRetry: () => void }) {
  const [dismissed, setDismissed] = useState(() => windowStore.get(seenKey(request.id)) === "1");
  const [sound, setSound] = useState(true);
  const open = isFallbackDue(request) && !dismissed;
  const panelRef = useRef<HTMLDivElement>(null);
  const callRef = useRef<HTMLAnchorElement>(null);

  const dismiss = useCallback(() => {
    windowStore.set(seenKey(request.id), "1");
    setDismissed(true);
  }, [request.id]);

  // Alarm: starts when the modal opens, stops on dismiss, on "silence", when the user taps the call button, and on unmount.
  useEffect(() => {
    if (!open || !sound) return;
    const stop = startAlarm();
    try { navigator.vibrate?.([400, 200, 400, 200, 400]); } catch { /* unsupported */ }
    return stop;
  }, [open, sound]);

  // Focus goes to the call button; Escape closes; Tab stays inside; the page behind does not scroll.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    callRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); dismiss(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (!panelRef.current.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, dismiss]);

  if (!open) return null;

  const p = request.requesterProfile;
  const contact = [p?.emergencyContactName, p?.emergencyContactPhone].map((s) => s?.trim()).filter(Boolean).join(" · ");
  const texted = !!request.emergencyContactNotifiedAt;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-resq-navy-dark/95 p-4 backdrop-blur-sm sm:p-6">
      <style href="resq-fallback-modal" precedence="medium">{CSS}</style>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="resq-fallback-title" aria-describedby="resq-fallback-desc"
        className="card-shadow-lg animate-slide-up w-full max-w-md overflow-hidden rounded-3xl bg-white">
        <div className="bg-emergency-gradient px-5 pb-5 pt-6 text-center text-white">
          <div className="animate-dispatch-pulse mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-white/20" aria-hidden="true"><Icon.AlertTriangle size={34} /></div>
          <h2 id="resq-fallback-title" className="font-display text-2xl font-bold">No local helper responded</h2>
          <p id="resq-fallback-desc" className="mt-1.5 text-sm text-white">
            {request.location ? "Nobody nearby accepted in time. Emergency services are your fastest help now." : "We could not get your location, so neighbours could not be alerted. Call emergency services now."}
          </p>
        </div>
        <div className="space-y-3 p-5">
          <a ref={callRef} href="tel:112" onClick={() => setSound(false)} data-fallback-call
            className="resq-fallback-call flex min-h-20 items-center justify-center gap-3 rounded-2xl bg-resq-red px-5 py-4 text-center font-display text-lg font-bold leading-snug text-white outline-none focus-visible:ring-4 focus-visible:ring-resq-navy/60">
            <Icon.Phone size={28} className="flex-shrink-0" />
            <span>No local helper responded · Tap to call 112 immediately</span>
          </a>

          {texted ? (
            <p className="flex items-start gap-2 rounded-xl bg-resq-green-light p-3 text-sm font-medium text-green-800">
              <Icon.Check size={16} className="mt-0.5 flex-shrink-0" /><span>We texted your emergency contact{contact ? ` ${contact}` : ""}</span>
            </p>
          ) : contact ? (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm font-medium text-amber-900">
              <Icon.MessageSquare size={16} className="mt-0.5 flex-shrink-0" /><span>Your emergency contact {contact} has not been texted yet. Call them as well.</span>
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-xl bg-slate-100 p-3 text-sm text-resq-navy">
              <Icon.User size={16} className="mt-0.5 flex-shrink-0" /><span>Add an emergency contact in your profile so we can alert them next time.</span>
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { dismiss(); onRetry(); }} className="min-h-12 rounded-2xl border border-slate-200 text-sm font-semibold text-resq-navy">Try again</button>
            <button type="button" onClick={dismiss} className="min-h-12 rounded-2xl bg-resq-navy text-sm font-semibold text-white">I understand</button>
          </div>
          <button type="button" onClick={() => setSound((s) => !s)} aria-pressed={!sound}
            className="flex min-h-10 w-full items-center justify-center gap-1.5 text-xs font-semibold text-resq-slate">
            <Icon.Bell size={14} />{sound ? "Silence alarm" : "Alarm silenced · tap to turn it back on"}
          </button>
        </div>
      </div>
    </div>
  );
}
