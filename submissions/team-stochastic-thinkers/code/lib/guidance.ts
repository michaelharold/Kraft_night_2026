/**
 * Sahaya guidance cards (README §4, §8, §10 rule 9; CONTRACTS §7).
 *
 * Static, curated "what do I do right now" text shown to the requester while
 * helpers are being dispatched. The LLM never writes or edits this content; it
 * only selects the card via `triage.type`. Every card follows public first-aid
 * guidance (IFRC / Indian Red Cross, WHO, St John Ambulance, NDMA) and is
 * deliberately conservative: no medication doses, no improvised procedures.
 *
 * Content rules (kept by hand, checked by tests):
 *   - steps: 3–6 imperative sentences, ≤ 90 characters each; the FIRST step is
 *     the single most important action.
 *   - doNot: 2–4 items. call112When: 2–4 concrete conditions.
 *   - source: the public material the wording follows.
 *
 * The 11 non-`other` cards are the README's "11 guidance cards"; `other` is the
 * generic "stay safe, call 112" card required because `Record<NeedType, …>` needs
 * all 12 keys (CONTRACTS §7).
 */
import type { GuidanceCard, NeedType } from "./types";

export const GUIDANCE_DISCLAIMER =
  "Curated first-aid guidance. Not a substitute for 112 or a medical professional.";

const CARDS: Record<NeedType, Omit<GuidanceCard, "selfSteps">> = {
  cardiac_no_breathing: {
    type: "cardiac_no_breathing",
    title: "Not breathing / cardiac arrest",
    steps: [
      "Start hands-only CPR: push hard and fast in the centre of the chest, 100–120 a minute.",
      "Put your phone on speaker and call 112 while you keep pushing.",
      "Let the chest come fully back up between pushes; swap with someone every 2 minutes.",
      "Do not stop until the person breathes, help arrives, or an AED is ready to use.",
      "If an AED arrives, switch it on and follow its spoken instructions.",
    ],
    doNot: [
      "Do not stop CPR to check for a pulse.",
      "Do not give food, drink or medicine.",
      "Do not wait for an ambulance before starting CPR.",
    ],
    call112When: [
      "The person is not breathing or only gasping.",
      "The person does not wake when you shout and tap their shoulders.",
      "The person collapsed suddenly.",
    ],
    source: "IFRC / Indian Red Cross first aid; AHA hands-only CPR",
  },

  bleeding: {
    type: "bleeding",
    title: "Severe bleeding",
    steps: [
      "Apply firm direct pressure on the wound with a clean cloth.",
      "Keep pressing, don't peek; add more cloth on top if it soaks through.",
      "Raise the limb if possible, above the level of the heart.",
      "Lay the person down and keep them warm while you wait for help.",
      "If trained and bleeding is life-threatening, apply a tourniquet above the wound.",
    ],
    doNot: [
      "Do not remove embedded objects; press around them instead.",
      "Do not lift the cloth to check the wound.",
      "Do not give the person anything to eat or drink.",
    ],
    call112When: [
      "Bleeding soaks through the cloth or will not stop.",
      "The person is pale, drowsy, confused or cold.",
      "There is an embedded object, or a deep wound to the chest, neck or belly.",
    ],
    source: "IFRC / Indian Red Cross first aid; St John Ambulance",
  },

  snakebite: {
    type: "snakebite",
    title: "Snakebite",
    steps: [
      "Keep the person still and calm; movement spreads venom faster.",
      "Keep the bitten limb still and below the level of the heart.",
      "Remove rings, watches and tight clothing near the bite before it swells.",
      "Note the time of the bite and, only if safe, the colour and pattern of the snake.",
      "Get to a hospital with antivenom as fast as possible; carry the person if you can.",
    ],
    doNot: [
      "Do not cut the bite, suck out venom, or apply ice.",
      "Do not tie a tight band or tourniquet around the limb.",
      "Do not try to catch or kill the snake.",
    ],
    call112When: [
      "Any snakebite: treat every bite as serious.",
      "Trouble breathing, drooping eyelids, bleeding gums or dark urine.",
      "Swelling spreading quickly up the limb, or the person collapses.",
    ],
    source: "WHO snakebite guidance; Indian Red Cross first aid",
  },

  electrical: {
    type: "electrical",
    title: "Electric shock",
    steps: [
      "Do not touch the person until the power is switched off at the mains.",
      "If you cannot cut the power, push them clear with a dry wooden or plastic object.",
      "Once clear, check for breathing; start hands-only CPR if they are not breathing.",
      "Cool any burns with clean running water and cover loosely with a clean cloth.",
      "Keep everyone away from fallen or wet wires; stay back at least 10 metres.",
    ],
    doNot: [
      "Do not touch the person or the wire with bare hands or anything wet or metal.",
      "Do not go near high-voltage lines or wires lying in water.",
      "Do not move the person unless they are in danger.",
    ],
    call112When: [
      "The person is unresponsive, not breathing, or has burns.",
      "A wire is down or live equipment is in water.",
      "The person was shocked by high voltage, even if they seem fine.",
    ],
    source: "St John Ambulance; IFRC / Indian Red Cross first aid",
  },

  fire: {
    type: "fire",
    title: "Fire",
    steps: [
      "Get out and stay out; leave belongings behind.",
      "Stay low under the smoke and cover your mouth and nose with a cloth.",
      "Close doors behind you to slow the fire and smoke.",
      "If clothes catch fire: stop, drop and roll to smother the flames.",
      "Meet at a safe spot outside and count everyone; tell 112 who is missing.",
    ],
    doNot: [
      "Do not go back inside for anything.",
      "Do not use lifts.",
      "Do not open a door that feels hot; find another way out.",
      "Do not throw water on an electrical or cooking-oil fire.",
    ],
    call112When: [
      "Any fire you cannot put out in seconds.",
      "Someone is trapped inside or missing.",
      "Someone has burns, or has breathed in smoke and is coughing or confused.",
    ],
    source: "Indian Red Cross fire safety; NDMA; St John Ambulance",
  },

  flood_rescue: {
    type: "flood_rescue",
    title: "Flood",
    steps: [
      "Do not enter moving water; even knee-deep water can sweep you away.",
      "Get to the highest floor or the roof and stay there.",
      "Signal for help with a torch, a phone light or a bright cloth.",
      "Switch off the mains electricity and gas if you can do it safely.",
      "Keep children and elderly close and hold on to each other.",
      "If someone is in the water, throw a rope, a can or anything that floats.",
    ],
    doNot: [
      "Do not walk, swim or drive through flood water.",
      "Do not touch electrical switches or wires with wet hands.",
      "Do not enter the water to rescue someone; reach or throw instead.",
    ],
    call112When: [
      "Someone is in the water or being carried away.",
      "Water is rising fast and you cannot get higher.",
      "Someone is injured, unconscious, or cannot move.",
    ],
    source: "IFRC / Indian Red Cross flood safety; NDMA",
  },

  trapped_structural: {
    type: "trapped_structural",
    title: "Trapped under debris",
    steps: [
      "Do not move debris that may be holding something up.",
      "Cover your mouth and nose with a cloth to keep dust out.",
      "Tap on a pipe or wall so rescuers can hear where you are.",
      "Shout only as a last resort; it wastes breath and draws in dust.",
      "Stay still and calm; save your energy and phone battery.",
      "Tell 112 the building, the floor and roughly where the person is.",
    ],
    doNot: [
      "Do not pull anything out from under a pile.",
      "Do not light a match or lighter; there may be gas.",
      "Do not move an injured person unless they are in immediate danger.",
    ],
    call112When: [
      "Anyone is trapped under debris.",
      "The building is still moving, cracking or leaking gas.",
      "A trapped person stops responding.",
    ],
    source: "IFRC / Indian Red Cross; NDMA earthquake and landslide guidance",
  },

  fracture: {
    type: "fracture",
    title: "Broken bone",
    steps: [
      "Keep the injured part still, exactly as it is.",
      "Pad and support it with cushions, rolled cloth or a splint.",
      "Put a cold pack wrapped in cloth on the area to ease swelling.",
      "Give nothing to eat or drink in case surgery is needed.",
      "Cover any open wound with a clean cloth without pressing on the bone.",
    ],
    doNot: [
      "Do not straighten the limb or push bone back in.",
      "Do not move the person if the neck, back or hip may be hurt.",
      "Do not give food, drink or painkillers.",
    ],
    call112When: [
      "Bone is showing, or the limb looks bent or twisted.",
      "The neck, back, head, hip or thigh may be injured.",
      "The limb is numb, blue, or cold below the injury.",
      "The person is pale, sweaty or drowsy.",
    ],
    source: "St John Ambulance; Indian Red Cross first aid",
  },

  evacuation_mobility: {
    type: "evacuation_mobility",
    title: "Evacuating someone who can't walk",
    steps: [
      "Move the person with two people: a chair carry or a blanket carry.",
      "Take medicines, documents, phone and charger in one bag.",
      "Use the stairs, never the lift.",
      "Tell a neighbour where you are going and who is with you.",
      "Go to the nearest relief camp or a sturdy building on high ground.",
    ],
    doNot: [
      "Do not use lifts.",
      "Do not carry the person alone if a second pair of hands is close.",
      "Do not leave a person who cannot move alone to fetch things.",
    ],
    call112When: [
      "The person cannot be moved safely and water or fire is approaching.",
      "The person is on oxygen, a ventilator or dialysis.",
      "The person becomes breathless, confused or unresponsive.",
    ],
    source: "IFRC / Indian Red Cross; NDMA evacuation guidance",
  },

  supplies_oxygen_meds: {
    type: "supplies_oxygen_meds",
    title: "Oxygen or medicines needed",
    steps: [
      "Keep a breathless person sitting up, leaning slightly forward.",
      "List exactly what is needed and how much, as written on the prescription.",
      "Send a photo of the prescription or the medicine box to the helper.",
      "Keep the person calm and still so they use less oxygen.",
      "Check how much supply is left and when it runs out; tell the helper.",
    ],
    doNot: [
      "Do not share oxygen masks or tubing between patients without cleaning them.",
      "Do not change a dose or give another person's medicine.",
      "Do not let anyone smoke or use flames near oxygen.",
    ],
    call112When: [
      "The person struggles to breathe, has blue lips, or cannot finish a sentence.",
      "Oxygen will run out before help can arrive.",
      "A person on insulin or heart medicine becomes confused or drowsy.",
    ],
    source: "WHO; Indian Red Cross first aid; St John Ambulance",
  },

  missing_person: {
    type: "missing_person",
    title: "Missing person",
    steps: [
      "Note the last-seen time, place and clothing, and find a recent photo.",
      "One person stays at the meeting point in case they return.",
      "Check nearby water and enclosed spaces first: tanks, wells, vehicles, sheds.",
      "Never enter water to search; look from the edge and call for help.",
      "Ask neighbours and shopkeepers; share the photo in local groups.",
    ],
    doNot: [
      "Do not enter water or a damaged building to search.",
      "Do not send everyone out; keep someone at home or the meeting point.",
      "Do not wait hours before reporting a missing child.",
    ],
    call112When: [
      "A child or a vulnerable adult is missing: call immediately.",
      "The person was last seen near water or a landslide.",
      "The person needs regular medicines and has missed a dose.",
    ],
    source: "Indian Red Cross; Childline India; NDMA guidance",
  },

  other: {
    type: "other",
    title: "Stay safe, get help",
    steps: [
      "Move yourself and the person to a safe place away from water, fire or traffic.",
      "Stay with the person; keep them warm and calm.",
      "Describe exactly what you see to the helper and to 112: who, where, what is wrong.",
      "If they are not breathing, start hands-only CPR and put 112 on speaker.",
      "Keep your phone charged and stay reachable.",
    ],
    doNot: [
      "Do not leave the person alone.",
      "Do not give food, drink or medicine unless a medical helper says so.",
      "Do not move someone with a possible neck or back injury unless in danger.",
    ],
    call112When: [
      "Anyone is unconscious, not breathing, or bleeding heavily.",
      "You are unsure how serious it is.",
      "The situation is getting worse and no helper has arrived.",
    ],
    source: "IFRC / Indian Red Cross first aid",
  },
};

/** The static card for a need type. Total: never throws, since `GUIDANCE` covers every NeedType. */
/**
 * Curated steps for when the requester IS the person in trouble (victim), not a bystander. Same sources and
 * rules as the witness steps: static text, no doses, first step is the most important action.
 */
const SELF_STEPS: Record<NeedType, string[]> = {
  flood_rescue: ["Move to the highest floor or roof now.", "Do not walk or drive through moving water.",
    "Switch off the mains power if you can do it safely.", "Signal with a torch, phone light or bright cloth.",
    "Save phone battery and keep it dry."],
  cardiac_no_breathing: ["Stop what you are doing and sit or lie down now.", "Call 112 or ask anyone nearby to call.",
    "Unlock your door so help can get in.", "Loosen tight clothing and keep your phone in your hand.",
    "Tell anyone near you that you may need CPR."],
  bleeding: ["Press firmly on the wound with a clean cloth.", "Keep pressing. Don't lift it to check.",
    "Sit or lie down so you don't faint.", "Raise the injured part if you can.", "Don't pull out anything stuck in the wound."],
  fracture: ["Stay still and don't put weight on the injury.", "Support the injured part in the position you found it.",
    "Hold a cold pack wrapped in cloth against it.", "Don't eat or drink in case you need surgery."],
  electrical: ["Move away from the wire or appliance only if you can do it safely.", "Don't touch anything wet or metal.",
    "Sit down: a shock can affect your heart even if you feel fine.", "Cool any burn under clean running water for 20 minutes."],
  fire: ["Get out now and stay out.", "Stay low, under the smoke.", "Feel doors before opening. If hot, use another way.",
    "If your clothes catch fire: stop, drop and roll.", "If trapped, close the door, block gaps and signal from a window."],
  trapped_structural: ["Stay still so you don't bring debris down.", "Cover your mouth and nose with cloth.",
    "Tap on a pipe or wall so rescuers can hear you.", "Shout only as a last resort to save breath.", "Text instead of calling to save battery."],
  snakebite: ["Keep as still and calm as you can.", "Keep the bitten limb still and below heart level.",
    "Remove rings, watches and tight clothing near the bite.", "Note the time of the bite.", "Don't cut, suck, ice or tie the bite."],
  evacuation_mobility: ["Stay where you are and tell us exactly where.", "Gather medicines, documents, phone and charger.",
    "Move to the highest safe floor if you can.", "Keep warm and dry; signal with a light.", "Don't use lifts."],
  supplies_oxygen_meds: ["Sit upright and breathe slowly if you are breathless.", "List exactly what you need and how much.",
    "Photograph your prescription.", "Use your remaining supply sparingly until help arrives."],
  missing_person: ["If you are lost, stay where you are if it is safe.", "Call or text someone you know.",
    "Stay visible and near a landmark.", "Save phone battery."],
  other: ["Move to a safe place if you can.", "Tell us what you see and where you are.", "Keep your phone on and near you."],
};

export const GUIDANCE: Record<NeedType, GuidanceCard> = Object.fromEntries(
  (Object.keys(CARDS) as NeedType[]).map((t) => [t, { ...CARDS[t], selfSteps: SELF_STEPS[t] }]),
) as Record<NeedType, GuidanceCard>;

export function getGuidance(type: NeedType): GuidanceCard {
  return GUIDANCE[type];
}
