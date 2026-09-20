"use client";
import { Icon } from "./icons";

/** Visible, pausable indicator that this signed-in window is sharing its location with authorities. */
export function BeaconChip({ paused, ago, source, onToggle, light = false }: {
  paused: boolean; ago: number | null; source: "gps" | "demo" | null; onToggle: (pause: boolean) => void; light?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${light ? "bg-white/10 text-white/80" : "bg-slate-50 text-resq-slate"}`}>
      <Icon.MapPin size={14} className={paused ? "opacity-50" : "text-resq-green"} />
      <span className="flex-1">
        {paused ? "Location sharing paused" : `Sharing your location so nearby jobs reach you${source === "demo" ? " (demo spot)" : ""} · ${ago === null ? "starting…" : `${ago}s ago`}`}
      </span>
      <button onClick={() => onToggle(!paused)} className={`min-h-9 rounded-lg px-2.5 font-semibold ${light ? "bg-white/15 text-white" : "bg-white text-resq-navy shadow-sm"}`}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
