/**
 * Scene hazards. The AI (or the keyword rules) only CLASSIFIES the hazard kind; the words a frightened person
 * reads on the warning banner come from this curated table, never from the model (README §10 rule 9: an LLM
 * must not improvise safety instructions). The API still returns the { hasHazard, hazardTitle, hazardAction } shape.
 */
import type { HazardAlert } from "./types";

export const HAZARD_KINDS = [
  "electrocution", "gas_leak", "fire_smoke", "fast_water", "structural_collapse",
  "contaminated_water", "chemical", "traffic", "animal", "other", "none",
] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

export const HAZARDS: Record<Exclude<HazardKind, "none">, { title: string; action: string }> = {
  electrocution: { title: "DANGER: HIGH RISK OF ELECTROCUTION", action: "Shut off the main breaker before touching standing water or anything wet. Stay out of the water until the power is off." },
  gas_leak: { title: "DANGER: POSSIBLE GAS LEAK", action: "Do not switch anything on or off and do not light a flame. Open doors and windows, get everyone outside, then call 112." },
  fire_smoke: { title: "DANGER: FIRE AND SMOKE", action: "Get out and stay out. Stay low under smoke, close doors behind you, and never go back inside." },
  fast_water: { title: "DANGER: FAST-MOVING WATER", action: "Do not walk or drive through moving water. Move to higher ground and wait for a boat or rope rescue." },
  structural_collapse: { title: "DANGER: BUILDING MAY COLLAPSE", action: "Stay out of the damaged structure and away from cracked walls. Do not move debris that may be holding something up." },
  contaminated_water: { title: "WARNING: CONTAMINATED FLOOD WATER", action: "Avoid contact with flood water and do not drink tap water until it is declared safe. Wash any wound with clean water." },
  chemical: { title: "DANGER: HAZARDOUS CHEMICALS", action: "Move upwind, away from the spill or fumes. Do not touch the substance; cover your nose and mouth." },
  traffic: { title: "DANGER: LIVE TRAFFIC", action: "Get off the road and behind a barrier. Switch on hazard lights and warn oncoming traffic from a safe place." },
  animal: { title: "DANGER: SNAKE OR ANIMAL NEARBY", action: "Keep still and back away slowly. Do not try to catch or kill it; keep others away from the area." },
  other: { title: "DANGER: POSSIBLE HAZARD AT THE SCENE", action: "Keep a safe distance until you are sure the area is safe. Tell your helper and 112 exactly what you see." },
};

export const NO_HAZARD: HazardAlert = { hasHazard: false, kind: "none", hazardTitle: null, hazardAction: null };

export function isHazardKind(x: unknown): x is HazardKind {
  return typeof x === "string" && (HAZARD_KINDS as readonly string[]).includes(x);
}

/** Curated alert for a classified hazard kind ("none" → NO_HAZARD). */
export function hazardAlertFor(kind: HazardKind): HazardAlert {
  if (kind === "none") return NO_HAZARD;
  const h = HAZARDS[kind];
  return { hasHazard: true, kind, hazardTitle: h.title, hazardAction: h.action };
}
