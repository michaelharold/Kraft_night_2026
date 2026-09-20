import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EQUIPMENT,
  detectEquipmentByRules,
  detectHazardByRules,
  normalizeForScan,
  normalizeText,
  triageByRules,
} from "../lib/triage-rules";
import { HAZARDS, HAZARD_KINDS, NO_HAZARD } from "../lib/hazards";
import type { HazardKind } from "../lib/hazards";
import type { Equipment } from "../lib/types";

// ---------------------------------------------------------------------------
// hazards — one deterministic kind per text, "none" when nothing fires
// ---------------------------------------------------------------------------

const HAZARD_CASES: [string, HazardKind][] = [
  // the four demo phrases (docs/UPGRADE.md §2)
  ["Basement flooded, need pump", "electrocution"],
  ["smell of gas in the kitchen", "gas_leak"],
  ["house flooded, water rising fast outside", "electrocution"], // indoor water beats the visible flood; fast_water is also acceptable per the contract
  ["my father collapsed, not breathing", "none"],
  // electrocution: indoor flooding / standing water / water near electricity / live wires
  ["water entered the house", "electrocution"],
  ["standing water in the shop", "electrocution"],
  ["rain water is dripping on the switchboard", "electrocution"],
  ["water near the meter box", "electrocution"],
  ["the wire is wet, current is on", "electrocution"],
  ["a live wire has fallen on the road", "electrocution"],
  ["vellam keri, current undu", "electrocution"],
  // gas
  ["LPG cylinder is leaking", "gas_leak"],
  ["gas leaking from the stove", "gas_leak"],
  ["I can smell cooking gas", "gas_leak"],
  ["smell of gas, no fire yet", "gas_leak"],
  // fire
  ["smoke coming from the neighbour's house", "fire_smoke"],
  ["something is burning in the shop", "fire_smoke"],
  ["kitchen is on fire", "fire_smoke"],
  ["gas leak, the kitchen is on fire", "fire_smoke"], // fire wins over gas: "get out" beats "open the windows"
  ["cylinder blast in the next flat", "fire_smoke"],
  ["thee pidichu", "fire_smoke"],
  // fast water
  ["Water is rising, my grandmother can't walk", "fast_water"],
  ["two people swept away", "fast_water"],
  ["the river is overflowing", "fast_water"],
  ["strong current, cannot cross", "fast_water"],
  ["water rising fast on the road", "fast_water"],
  // structural
  ["big crack in the wall after the rain", "structural_collapse"],
  ["the wall has collapsed on a man", "structural_collapse"],
  ["people trapped under the collapsed building", "structural_collapse"],
  ["landslide near the estate", "structural_collapse"],
  ["wall fell on the car", "structural_collapse"],
  ["roof came down, people under the rubble", "structural_collapse"],
  // contaminated water
  ["sewage water on the street", "contaminated_water"],
  ["the drain is overflowing", "contaminated_water"],
  ["dirty flood water everywhere", "contaminated_water"],
  // chemical
  ["acid spilled in the lab", "chemical"],
  ["strong chemical fumes from the factory", "chemical"],
  ["he drank pesticide", "chemical"],
  // traffic
  ["road accident, two people injured", "traffic"],
  ["accident on the highway", "traffic"],
  ["a lorry hit a bike", "traffic"],
  ["hit by a car", "traffic"],
  ["met with an accident near the junction", "traffic"],
  // animal
  ["snake in the kitchen", "animal"],
  ["snake bit my son", "animal"],
  ["stray dogs attacking a child", "animal"],
  ["bees attacked the workers", "animal"],
  ["wasps nest fell", "animal"],
  ["wild elephant on the road", "animal"],
];

test("detectHazardByRules classifies every hazard kind", () => {
  for (const [text, want] of HAZARD_CASES) {
    assert.equal(detectHazardByRules(text), want, JSON.stringify(text));
  }
});

test("detectHazardByRules covers every kind except other/none (which only the model can produce)", () => {
  const seen = new Set(HAZARD_CASES.map(([text]) => detectHazardByRules(text)));
  for (const kind of HAZARD_KINDS) {
    if (kind === "other") continue;
    assert.ok(seen.has(kind), `no rule case produced ${kind}`);
  }
  assert.ok(!seen.has("other"));
});

test("detectHazardByRules stays quiet on medical emergencies and landmarks (no false alarms)", () => {
  const quiet = [
    "my father collapsed, not breathing",
    "My father collapsed. Building 4, second floor", // punctuation keeps "collapsed" and "building" apart
    "my father collapsed building 4 second floor", // voice transcripts have no punctuation
    "At my house father collapsed",
    "in my house father fell down and broke his leg",
    "father collapsed near the river bridge", // a river as a landmark is not a hazard
    "No drinking water and no power for two days", // supplies, not water near electricity
    "water is 2 meter deep on the road", // "meter" after a number is a length
    "burning sensation in chest",
    "fire force has not come, we are stuck on the terrace",
    "my dog is missing",
    "I cannot bear the pain",
    "child has high fever",
    "deep cut on the hand, bleeding a lot",
    "need insulin for my mother",
    "fell from ladder leg is bent",
    "",
    "   ",
  ];
  for (const text of quiet) assert.equal(detectHazardByRules(text), "none", JSON.stringify(text));
});

test("detectHazardByRules never throws on odd input", () => {
  assert.equal(detectHazardByRules(undefined as unknown as string), "none");
  assert.equal(detectHazardByRules(null as unknown as string), "none");
  assert.equal(detectHazardByRules(42 as unknown as string), "none");
  assert.equal(detectHazardByRules("x".repeat(20_000)), "none");
  assert.equal(detectHazardByRules(`${"a ".repeat(3000)} live wire`), "none"); // beyond the 4000-char scan window
});

test("normalizeForScan keeps clause breaks as a marker and drops the rest of the punctuation", () => {
  assert.equal(normalizeForScan("Father collapsed. Building 4, 2nd floor!"), "father collapsed | building 4 | 2nd floor |");
  assert.equal(normalizeForScan("first-aid kit, can't walk"), "first aid kit | cant walk");
  assert.equal(normalizeForScan(""), "");
  assert.equal(normalizeForScan(7), "");
  assert.equal(normalizeText("Father collapsed. Building 4"), "father collapsed building 4"); // the type scorer is unchanged
});

// ---------------------------------------------------------------------------
// equipment — what the text asks for, max 4
// ---------------------------------------------------------------------------

const EQUIPMENT_CASES: [string, Equipment[]][] = [
  ["Basement flooded, need pump", ["water_pump"]],
  ["need a ladder and rope", ["rope_ladder"]],
  ["oxygen cylinder is empty", ["oxygen_cylinder"]],
  ["need a stretcher", ["stretcher_wheelchair"]],
  ["she is in a wheelchair", ["stretcher_wheelchair"]],
  ["bring life jackets", ["life_jacket"]],
  ["fallen tree blocking the road, need a chainsaw", ["chainsaw_cutter"]],
  ["tree fell across the lane", ["chainsaw_cutter"]],
  ["need torch and power bank", ["torch_powerbank"]],
  ["phone battery dying, no light", ["torch_powerbank"]],
  ["bring a fire extinguisher", ["fire_extinguisher"]],
  ["need a vehicle to the hospital", ["car"]],
  ["ambulance is not coming", ["car"]],
  ["need first-aid kit and bandages", ["first_aid_kit"]],
  ["basement flooded need pump and a torch", ["water_pump", "torch_powerbank"]],
];

test("detectEquipmentByRules maps named equipment", () => {
  for (const [text, want] of EQUIPMENT_CASES) {
    assert.deepEqual(detectEquipmentByRules(text), want, JSON.stringify(text));
  }
});

test("detectEquipmentByRules ignores equipment that is part of the story, not a request", () => {
  const none = [
    "near the petrol pump", // a landmark
    "he fell from a ladder",
    "car accident on the bypass",
    "hit by a car",
    "trapped in the car",
    "wall fell on my car",
    "my father collapsed, not breathing",
    "",
  ];
  for (const text of none) assert.deepEqual(detectEquipmentByRules(text), [], JSON.stringify(text));
  assert.deepEqual(detectEquipmentByRules(undefined as unknown as string), []);
});

test(`detectEquipmentByRules keeps at most ${MAX_EQUIPMENT} items, in rule order, no duplicates`, () => {
  assert.equal(MAX_EQUIPMENT, 4);
  const got = detectEquipmentByRules("need pump, oxygen, stretcher, life jacket, rope, chainsaw, torch, extinguisher, pump again");
  assert.deepEqual(got, ["water_pump", "oxygen_cylinder", "stretcher_wheelchair", "life_jacket"]);
  assert.equal(new Set(got).size, got.length);
});

// ---------------------------------------------------------------------------
// triageByRules carries both
// ---------------------------------------------------------------------------

test("triageByRules fills equipment and a curated hazardAlert", () => {
  const r = triageByRules("Basement flooded, need pump");
  assert.equal(r.source, "rules");
  assert.equal(r.type, "flood_rescue");
  assert.deepEqual(r.equipment, ["water_pump"]);
  assert.deepEqual(r.hazardAlert, {
    hasHazard: true,
    kind: "electrocution",
    hazardTitle: HAZARDS.electrocution.title,
    hazardAction: HAZARDS.electrocution.action,
  });
});

test("triageByRules reports no hazard and no equipment for a plain medical emergency", () => {
  const r = triageByRules("my father collapsed, not breathing");
  assert.equal(r.type, "cardiac_no_breathing");
  assert.equal(r.urgency, "critical");
  assert.deepEqual(r.equipment, []);
  assert.deepEqual(r.hazardAlert, NO_HAZARD);
});

test("triageByRules no-hit result still carries the fields", () => {
  const r = triageByRules("hello");
  assert.equal(r.type, "other");
  assert.equal(r.confidence, 0.2);
  assert.deepEqual(r.equipment, []);
  assert.deepEqual(r.hazardAlert, NO_HAZARD);
  const empty = triageByRules("");
  assert.deepEqual(empty.equipment, []);
  assert.deepEqual(empty.hazardAlert, NO_HAZARD);
});

test("triageByRules: hazard and equipment are independent of the need type", () => {
  const r = triageByRules("snake bit my son, need a vehicle to the hospital");
  assert.equal(r.type, "snakebite");
  assert.equal(r.hazardAlert.kind, "animal");
  assert.deepEqual(r.equipment, ["car"]);
});
