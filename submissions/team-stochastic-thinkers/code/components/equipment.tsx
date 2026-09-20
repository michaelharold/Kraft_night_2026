import { Icon } from "./icons";
import { EQUIPMENT_LABELS } from "@/lib/taxonomy";
import type { Equipment, Skill } from "@/lib/types";

/** Equipment shown at sign-up: owned resources that live in SKILLS (boat, 4×4, generator) plus EQUIPMENT. */
export type Capability = { kind: "skill"; id: Skill } | { kind: "equipment"; id: Equipment };
export const RESOURCE_SKILLS: Skill[] = ["boat_owner", "driver_4x4", "generator_owner"];
export const PERSON_SKILLS: Skill[] = ["doctor", "nurse", "first_aid", "swimmer", "electrician", "plumber", "counselor", "volunteer"];

export const EQUIPMENT_META: Record<Equipment, { color: string; bg: string; icon: React.ReactNode }> = {
  first_aid_kit: { color: "#DC2626", bg: "#FEF2F2", icon: <Icon.Plus size={18} /> },
  oxygen_cylinder: { color: "#0EA5E9", bg: "#F0F9FF", icon: <Icon.Activity size={18} /> },
  stretcher_wheelchair: { color: "#7C3AED", bg: "#FAF5FF", icon: <Icon.User size={18} /> },
  rope_ladder: { color: "#92400E", bg: "#FEF3C7", icon: <Icon.Anchor size={18} /> },
  life_jacket: { color: "#EA580C", bg: "#FFF7ED", icon: <Icon.Waves size={18} /> },
  water_pump: { color: "#2563EB", bg: "#EFF6FF", icon: <Icon.Droplets size={18} /> },
  chainsaw_cutter: { color: "#475569", bg: "#F1F5F9", icon: <Icon.Zap size={18} /> },
  torch_powerbank: { color: "#CA8A04", bg: "#FEFCE8", icon: <Icon.Power size={18} /> },
  fire_extinguisher: { color: "#B91C1C", bg: "#FEF2F2", icon: <Icon.Flame size={18} /> },
  car: { color: "#16A34A", bg: "#F0FDF4", icon: <Icon.Truck size={18} /> },
};

export function EquipmentPill({ item }: { item: Equipment }) {
  const m = EQUIPMENT_META[item];
  return <span className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-medium" style={{ background: m.bg, color: m.color }}>{EQUIPMENT_LABELS[item]}</span>;
}
