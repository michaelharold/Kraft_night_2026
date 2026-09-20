/*
 * Hazard Warning Banner (upgrade §2). The AI (or the keyword rules) only classifies the hazard KIND; the words shown
 * here come from the curated table in lib/hazards.ts, never from the model. Renders nothing when there is no hazard.
 * No hooks, so it works in server and client components alike.
 */
import { Icon } from "./icons";
import type { HazardAlert } from "@/lib/types";

/*
 * Amber-700 ↔ red-700: white text keeps a contrast ratio above 4.5:1 at both ends of the pulse.
 * The global `prefers-reduced-motion` rule in app/globals.css neutralises these animations; the static
 * fallback is the solid red background below.
 */
const CSS = `
@keyframes resq-hazard-pulse {
  0%, 100% { background-color: #B45309; box-shadow: 0 0 0 0 rgba(220, 38, 38, .55), 0 4px 24px rgba(153, 27, 27, .25); }
  50% { background-color: #B91C1C; box-shadow: 0 0 0 10px rgba(220, 38, 38, 0), 0 4px 24px rgba(153, 27, 27, .35); }
}
@keyframes resq-hazard-icon { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }
.resq-hazard-banner { background-color: #B91C1C; animation: resq-hazard-pulse 1.4s ease-in-out infinite; }
.resq-hazard-icon { animation: resq-hazard-icon 1.4s ease-in-out infinite; }
.resq-hazard-tape { background-image: repeating-linear-gradient(135deg, #111827 0 12px, #FBBF24 12px 24px); }
`;

export function HazardBanner({ alert, compact = false, className = "" }: { alert: HazardAlert | null | undefined; compact?: boolean; className?: string }) {
  if (!alert?.hasHazard) return null;
  const title = alert.hazardTitle ?? "DANGER: POSSIBLE HAZARD AT THE SCENE";
  return (
    <section role="alert" aria-live="assertive" aria-atomic="true" data-hazard-kind={alert.kind}
      className={`resq-hazard-banner overflow-hidden text-white ${compact ? "rounded-xl" : "rounded-2xl"} ${className}`}>
      <style href="resq-hazard-banner" precedence="medium">{CSS}</style>
      <div className={`resq-hazard-tape ${compact ? "h-1" : "h-1.5"}`} aria-hidden="true" />
      <div className={`flex items-start ${compact ? "gap-2.5 px-3 py-2.5" : "gap-3.5 px-4 py-4 sm:px-5"}`}>
        <div aria-hidden="true" className={`resq-hazard-icon flex flex-shrink-0 items-center justify-center rounded-2xl bg-white text-resq-red ${compact ? "h-9 w-9" : "h-12 w-12"}`}>
          <Icon.AlertTriangle size={compact ? 20 : 28} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`font-display font-extrabold uppercase leading-tight tracking-wide ${compact ? "text-sm" : "text-lg sm:text-xl"}`}>{title}</p>
          {alert.hazardAction && <p className={`font-medium leading-snug ${compact ? "mt-0.5 text-xs" : "mt-1.5 text-sm sm:text-base"}`}>{alert.hazardAction}</p>}
          <p className={`${compact ? "mt-1 text-[11px]" : "mt-2 text-xs"} font-medium text-white`}>Curated safety warning · AI detected the hazard type</p>
        </div>
      </div>
    </section>
  );
}
