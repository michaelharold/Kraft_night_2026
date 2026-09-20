import { Icon } from "./icons";
import type { NeedType, Skill } from "@/lib/types";

/** Skill presentation (colours and icons follow the Figma COMMUNITY_SKILLS palette). */
export const SKILL_META: Record<Skill, { label: string; desc: string; color: string; bg: string; icon: React.ReactNode }> = {
  doctor: { label: "Doctor", desc: "Medical assessment & treatment", color: "#DC2626", bg: "#FEF2F2", icon: <Icon.Heart size={18} /> },
  nurse: { label: "Nurse", desc: "Clinical care & first aid", color: "#E11D48", bg: "#FFF1F2", icon: <Icon.Activity size={18} /> },
  first_aid: { label: "First aid", desc: "Trained first responder", color: "#EA580C", bg: "#FFF7ED", icon: <Icon.Plus size={18} /> },
  swimmer: { label: "Swimmer", desc: "Water rescue & recovery", color: "#0891B2", bg: "#ECFEFF", icon: <Icon.Waves size={18} /> },
  boat_owner: { label: "Boat owner", desc: "Vessel for water emergencies", color: "#0EA5E9", bg: "#F0F9FF", icon: <Icon.Anchor size={18} /> },
  electrician: { label: "Electrician", desc: "Electrical hazard response", color: "#CA8A04", bg: "#FEFCE8", icon: <Icon.Zap size={18} /> },
  plumber: { label: "Plumber", desc: "Water / flood mitigation", color: "#2563EB", bg: "#EFF6FF", icon: <Icon.Droplets size={18} /> },
  driver_4x4: { label: "4×4 driver", desc: "Off-road / flood access", color: "#16A34A", bg: "#F0FDF4", icon: <Icon.Truck size={18} /> },
  generator_owner: { label: "Generator", desc: "Backup power supply", color: "#D97706", bg: "#FFFBEB", icon: <Icon.Power size={18} /> },
  counselor: { label: "Counselor", desc: "Emotional support", color: "#9333EA", bg: "#FAF5FF", icon: <Icon.MessageSquare size={18} /> },
  volunteer: { label: "Volunteer", desc: "Extra hands on the ground", color: "#1E3A5F", bg: "#EFF6FF", icon: <Icon.User size={18} /> },
  carpenter: { label: "Carpenter", desc: "Doors, furniture, fittings", color: "#92400E", bg: "#FEF3C7", icon: <Icon.Building size={18} /> },
  ac_technician: { label: "AC technician", desc: "AC service, gas refill, repair", color: "#0891B2", bg: "#ECFEFF", icon: <Icon.Waves size={18} /> },
  appliance_repair: { label: "Appliance repair", desc: "Fridge, washing machine, TV", color: "#7C3AED", bg: "#FAF5FF", icon: <Icon.Battery size={18} /> },
  painter: { label: "Painter", desc: "Walls, touch-ups, waterproofing", color: "#DB2777", bg: "#FDF2F8", icon: <Icon.Star size={18} /> },
  cleaner: { label: "Cleaner", desc: "Home & deep cleaning", color: "#0D9488", bg: "#F0FDFA", icon: <Icon.Check size={18} /> },
  mechanic: { label: "Mechanic", desc: "Bike & car repair", color: "#475569", bg: "#F1F5F9", icon: <Icon.Truck size={18} /> },
  caregiver: { label: "Caregiver", desc: "Elderly & patient care", color: "#E11D48", bg: "#FFF1F2", icon: <Icon.User size={18} /> },
};

export function SkillPill({ skill }: { skill: Skill }) {
  const m = SKILL_META[skill];
  return (
    <span className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-medium" style={{ background: m.bg, color: m.color }}>
      {m.label}
    </span>
  );
}

/** Quick-pick tiles on the report screen. `hint` is prepended to the description so triage has a head start. */
export const EMERGENCY_TILES: { id: string; label: string; sub: string; hint: string; color: string; bg: string; icon: React.ReactNode; type: NeedType }[] = [
  { id: "medical", label: "Medical", sub: "Collapse, not breathing", hint: "Medical emergency:", color: "#DC2626", bg: "#FEF2F2", icon: <Icon.Heart size={26} />, type: "cardiac_no_breathing" },
  { id: "injury", label: "Injury", sub: "Bleeding, broken bone", hint: "Injury:", color: "#E11D48", bg: "#FFF1F2", icon: <Icon.Plus size={26} />, type: "bleeding" },
  { id: "flood", label: "Flood / Water", sub: "Rising water, evacuation", hint: "Flood:", color: "#0EA5E9", bg: "#F0F9FF", icon: <Icon.Droplets size={26} />, type: "flood_rescue" },
  { id: "fire", label: "Fire", sub: "Fire or smoke", hint: "Fire:", color: "#EA580C", bg: "#FFF7ED", icon: <Icon.Flame size={26} />, type: "fire" },
  { id: "trapped", label: "Trapped", sub: "Collapse, stuck", hint: "Trapped:", color: "#9333EA", bg: "#FAF5FF", icon: <Icon.Building size={26} />, type: "trapped_structural" },
  { id: "electrical", label: "Electrical", sub: "Shock, live wire", hint: "Electrical hazard:", color: "#CA8A04", bg: "#FEFCE8", icon: <Icon.Zap size={26} />, type: "electrical" },
  { id: "snake", label: "Snakebite", sub: "Bitten by a snake", hint: "Snake bite:", color: "#16A34A", bg: "#F0FDF4", icon: <Icon.AlertTriangle size={26} />, type: "snakebite" },
  { id: "supplies", label: "Oxygen / Meds", sub: "Supplies needed", hint: "Need oxygen or medicine:", color: "#D97706", bg: "#FFFBEB", icon: <Icon.Truck size={26} />, type: "supplies_oxygen_meds" },
];

export const URGENCY_STYLE: Record<string, string> = {
  critical: "bg-resq-red text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-400 text-resq-navy",
  low: "bg-slate-200 text-resq-navy",
};
