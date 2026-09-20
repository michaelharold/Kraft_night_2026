import { Icon } from "./icons";
import type { TrustTier } from "@/lib/types";

/** 3-tier trust badge: Tier 1 green Neighbor · Tier 2 blue Certified Pro · Tier 3 red First Responder. */
export const TIER_META: Record<TrustTier, { label: string; short: string; desc: string; color: string; bg: string; icon: React.ReactNode }> = {
  TIER_1_NEIGHBOR: { label: "Neighbor", short: "T1", desc: "Phone-verified community member", color: "#16A34A", bg: "#F0FDF4", icon: <Icon.User size={12} /> },
  TIER_2_CERTIFIED_PRO: { label: "Certified Pro", short: "T2", desc: "Licensed tradesperson: can accept paid household jobs", color: "#2563EB", bg: "#EFF6FF", icon: <Icon.Shield size={12} /> },
  TIER_3_FIRST_RESPONDER: { label: "First Responder", short: "T3", desc: "Medical / rescue professional: prioritised for critical emergencies", color: "#DC2626", bg: "#FEF2F2", icon: <Icon.Heart size={12} /> },
};

export function TrustBadge({ tier, compact = false }: { tier: TrustTier; compact?: boolean }) {
  const m = TIER_META[tier];
  return (
    <span title={`${m.label}: ${m.desc}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{ color: m.color, background: m.bg, borderColor: `${m.color}33` }}>
      {m.icon}{compact ? m.short : m.label}
    </span>
  );
}
