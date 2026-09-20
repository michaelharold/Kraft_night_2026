/**
 * Sahaya taxonomy — the single source of truth for skills, need types and urgencies
 * (README §4, CONTRACTS §1). Both the Ollama system prompt (lib/triage.ts) and the
 * keyword-rules fallback (lib/triage-rules.ts) read from this file; the UI and the
 * SMS templates use the label maps.
 *
 * This module must NOT import runtime values from ./types: types.ts derives its
 * Skill / NeedType / Urgency unions from the `as const` arrays below via `typeof`.
 * The import here is type-only and is erased at compile time, so there is no
 * runtime cycle between the two modules.
 */
import type { NeedType, Skill, Urgency } from "./types";

export const SKILLS = [
  "doctor",
  "nurse",
  "first_aid",
  "swimmer",
  "boat_owner",
  "electrician",
  "plumber",
  "driver_4x4",
  "generator_owner",
  "counselor",
  "volunteer",
  // Local services (community marketplace)
  "carpenter",
  "ac_technician",
  "appliance_repair",
  "painter",
  "cleaner",
  "mechanic",
  "caregiver",
] as const;

/**
 * Services a user can request with one tap, in display order. Each is also a skill a provider can offer.
 *
 * Trades only. doctor / nurse / caregiver were bookable here and are deliberately not any more: Sahaya is a local
 * trades marketplace, and dispatching medical care through it invites an expectation of clinical judgement the
 * product has no business making. Those three remain in SKILLS below because the emergency triage tables still
 * map need types onto them; they are simply not something a neighbour can book with a tap.
 */
export const SERVICES = [
  "plumber", "electrician", "carpenter", "ac_technician", "appliance_repair", "painter",
  "cleaner", "mechanic",
] as const satisfies readonly Skill[];
export type Service = (typeof SERVICES)[number];
export function isService(x: unknown): x is Service {
  return typeof x === "string" && (SERVICES as readonly string[]).includes(x);
}
export const NEED_TYPES = [
  "flood_rescue",
  "cardiac_no_breathing",
  "bleeding",
  "fracture",
  "electrical",
  "fire",
  "trapped_structural",
  "snakebite",
  "evacuation_mobility",
  "supplies_oxygen_meds",
  "missing_person",
  "other",
] as const;

export const URGENCIES = ["critical", "high", "medium", "low"] as const;

/**
 * Default skills per need type (CONTRACTS §1). Every array is non-empty; triage
 * falls back to `TYPE_SKILLS[type]` when the model returns no known skill.
 * These arrays are shared module state — copy (`[...TYPE_SKILLS[t]]`) before mutating.
 */
export const TYPE_SKILLS: Record<NeedType, Skill[]> = {
  flood_rescue: ["swimmer", "boat_owner", "first_aid"],
  cardiac_no_breathing: ["doctor", "nurse", "first_aid"],
  bleeding: ["nurse", "doctor", "first_aid"],
  fracture: ["nurse", "doctor", "first_aid", "driver_4x4"],
  electrical: ["electrician", "first_aid"],
  fire: ["volunteer", "first_aid", "driver_4x4"],
  trapped_structural: ["volunteer", "first_aid", "driver_4x4"],
  snakebite: ["doctor", "nurse", "driver_4x4"],
  evacuation_mobility: ["boat_owner", "swimmer", "driver_4x4"],
  supplies_oxygen_meds: ["driver_4x4", "volunteer", "nurse"],
  missing_person: ["volunteer", "counselor"],
  other: ["volunteer", "first_aid"],
};

/** Short human labels for skills (UI chips, checkboxes, SMS via `.toUpperCase()`). */
export const SKILL_LABELS: Record<Skill, string> = {
  doctor: "Doctor",
  nurse: "Nurse",
  first_aid: "First aid",
  swimmer: "Swimmer",
  boat_owner: "Boat owner",
  electrician: "Electrician",
  plumber: "Plumber",
  driver_4x4: "4×4 driver",
  generator_owner: "Generator owner",
  counselor: "Counselor",
  volunteer: "Volunteer",
  carpenter: "Carpenter",
  ac_technician: "AC technician",
  appliance_repair: "Appliance repair",
  painter: "Painter",
  cleaner: "Cleaner",
  mechanic: "Mechanic",
  caregiver: "Caregiver",
};

/** Short human labels for need types (triage chip on `/`, lists on `/ops`). */
export const TYPE_LABELS: Record<NeedType, string> = {
  flood_rescue: "Flood rescue",
  cardiac_no_breathing: "Cardiac arrest / not breathing",
  bleeding: "Severe bleeding",
  fracture: "Fracture / broken bone",
  electrical: "Electrical hazard",
  fire: "Fire",
  trapped_structural: "Trapped / structural collapse",
  snakebite: "Snakebite",
  evacuation_mobility: "Evacuation / mobility",
  supplies_oxygen_meds: "Oxygen / medicines / supplies",
  missing_person: "Missing person",
  other: "Other emergency",
};

/** ≤ 12 chars each; used only inside SMS templates so a ping stays one segment (CONTRACTS §1, §7). */
export const TYPE_SMS_LABELS: Record<NeedType, string> = {
  flood_rescue: "flood",
  cardiac_no_breathing: "cardiac",
  bleeding: "bleeding",
  fracture: "fracture",
  electrical: "electrical",
  fire: "fire",
  trapped_structural: "trapped",
  snakebite: "snakebite",
  evacuation_mobility: "evacuation",
  supplies_oxygen_meds: "supplies",
  missing_person: "missing",
  other: "emergency",
};

/** The one fixed clarifying question (README §4); set on TriageResult when the rules fallback is unsure. */
export const CLARIFYING_QUESTION =
  "Is anyone hurt, trapped, or in water right now? Tell me what you see.";

// Hand-written type guards (README §4: no schema libraries).

export function isSkill(x: unknown): x is Skill {
  return typeof x === "string" && (SKILLS as readonly string[]).includes(x);
}

export function isNeedType(x: unknown): x is NeedType {
  return typeof x === "string" && (NEED_TYPES as readonly string[]).includes(x);
}

export function isUrgency(x: unknown): x is Urgency {
  return typeof x === "string" && (URGENCIES as readonly string[]).includes(x);
}

// ─── Equipment (what people own that helps in an emergency) ──────────────────────────────────────────────────
// Boats, 4×4s and generators stay in SKILLS (dispatch already matches on them); this list adds the rest.
export const EQUIPMENT = [
  "first_aid_kit", "oxygen_cylinder", "stretcher_wheelchair", "rope_ladder", "life_jacket",
  "water_pump", "chainsaw_cutter", "torch_powerbank", "fire_extinguisher", "car",
] as const;
export type Equipment = (typeof EQUIPMENT)[number];
export const EQUIPMENT_LABELS: Record<Equipment, string> = {
  first_aid_kit: "First-aid kit", oxygen_cylinder: "Oxygen cylinder", stretcher_wheelchair: "Stretcher / wheelchair",
  rope_ladder: "Rope / ladder", life_jacket: "Life jackets", water_pump: "Water pump", chainsaw_cutter: "Chainsaw / cutter",
  torch_powerbank: "Torch / power bank", fire_extinguisher: "Fire extinguisher", car: "Car",
};
/** Equipment that is useful for each need type (used to show relevant requests to people who own it). */
export const TYPE_EQUIPMENT: Record<NeedType, Equipment[]> = {
  flood_rescue: ["life_jacket", "rope_ladder", "torch_powerbank"],
  cardiac_no_breathing: ["first_aid_kit", "oxygen_cylinder", "car"],
  bleeding: ["first_aid_kit", "car"],
  fracture: ["first_aid_kit", "stretcher_wheelchair", "car"],
  electrical: ["torch_powerbank", "first_aid_kit"],
  fire: ["fire_extinguisher", "first_aid_kit"],
  trapped_structural: ["chainsaw_cutter", "rope_ladder", "torch_powerbank"],
  snakebite: ["car", "first_aid_kit"],
  evacuation_mobility: ["stretcher_wheelchair", "life_jacket", "car"],
  supplies_oxygen_meds: ["oxygen_cylinder", "car"],
  missing_person: ["torch_powerbank", "car"],
  other: ["first_aid_kit", "torch_powerbank"],
};
export function isEquipment(x: unknown): x is Equipment {
  return typeof x === "string" && (EQUIPMENT as readonly string[]).includes(x);
}
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

// ─── Tools (what a provider carries; what the AI says a job needs) ───────────────────────────────────────────
// One fixed vocabulary shared by the AI scoping prompt and the provider profile, so MongoDB `$all` / `$in`
// matching compares like with like (free-text tool names would almost never match exactly).
export const TOOLS = [
  "pipe_wrench", "plunger", "pipe_sealant", "drain_snake",
  "multimeter", "voltage_tester", "wire_stripper", "insulation_tape",
  "power_drill", "ladder", "screwdriver_set", "hammer", "saw", "measuring_tape",
  "ac_gas_kit", "vacuum_pump", "paint_roller", "sandpaper",
  "vacuum_cleaner", "pressure_washer", "cleaning_kit",
  "spanner_set", "tyre_inflator", "jumper_cables",
  "bp_monitor", "thermometer", "glucometer", "stethoscope", "first_aid_kit",
] as const;
export type Tool = (typeof TOOLS)[number];
export function isTool(x: unknown): x is Tool {
  return typeof x === "string" && (TOOLS as readonly string[]).includes(x);
}
export const TOOL_LABELS: Record<Tool, string> = {
  pipe_wrench: "Pipe wrench", plunger: "Plunger", pipe_sealant: "Pipe sealant / tape", drain_snake: "Drain snake",
  multimeter: "Multimeter", voltage_tester: "Voltage tester", wire_stripper: "Wire stripper", insulation_tape: "Insulation tape",
  power_drill: "Power drill", ladder: "Ladder", screwdriver_set: "Screwdriver set", hammer: "Hammer", saw: "Saw", measuring_tape: "Measuring tape",
  ac_gas_kit: "AC gas kit", vacuum_pump: "Vacuum pump", paint_roller: "Paint roller & brushes", sandpaper: "Sandpaper",
  vacuum_cleaner: "Vacuum cleaner", pressure_washer: "Pressure washer", cleaning_kit: "Cleaning kit",
  spanner_set: "Spanner set", tyre_inflator: "Tyre inflator", jumper_cables: "Jumper cables",
  bp_monitor: "BP monitor", thermometer: "Thermometer", glucometer: "Glucometer", stethoscope: "Stethoscope", first_aid_kit: "First-aid kit",
};
/** Tools usually relevant to each service: offered as a checklist at sign-up and used to seed demo providers. */
export const SERVICE_TOOLS: Record<Service, Tool[]> = {
  plumber: ["pipe_wrench", "plunger", "pipe_sealant", "drain_snake", "power_drill", "screwdriver_set"],
  electrician: ["multimeter", "voltage_tester", "wire_stripper", "insulation_tape", "ladder", "screwdriver_set", "power_drill"],
  carpenter: ["power_drill", "saw", "hammer", "measuring_tape", "screwdriver_set", "sandpaper"],
  ac_technician: ["ac_gas_kit", "vacuum_pump", "multimeter", "ladder", "screwdriver_set"],
  appliance_repair: ["multimeter", "screwdriver_set", "voltage_tester", "spanner_set"],
  painter: ["paint_roller", "ladder", "sandpaper", "measuring_tape"],
  cleaner: ["vacuum_cleaner", "pressure_washer", "cleaning_kit"],
  mechanic: ["spanner_set", "tyre_inflator", "jumper_cables", "screwdriver_set"],
};
