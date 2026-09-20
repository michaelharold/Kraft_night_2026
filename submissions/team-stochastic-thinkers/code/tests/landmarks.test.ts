import { test } from "node:test";
import assert from "node:assert/strict";
import { LANDMARKS, matchLandmark, normaliseLandmarkText } from "../lib/landmarks";

const byName = (name: string) => LANDMARKS.find((l) => l.name === name);

test("table has at least 15 entries with valid shapes near TKMCE / Kollam", () => {
  assert.ok(LANDMARKS.length >= 15, `only ${LANDMARKS.length} landmarks`);
  const names = new Set<string>();
  for (const l of LANDMARKS) {
    assert.equal(typeof l.name, "string");
    assert.ok(l.name.length > 0);
    assert.ok(!names.has(l.name), `duplicate landmark name ${l.name}`);
    names.add(l.name);
    assert.ok(Array.isArray(l.aliases) && l.aliases.length >= 1, `${l.name} has no aliases`);
    for (const a of l.aliases) assert.ok(normaliseLandmarkText(a).length > 0, `${l.name}: empty alias`);
    assert.equal(typeof l.location.lat, "number");
    assert.equal(typeof l.location.lng, "number");
    // demo-plausible: within a few km of campus centre (8.913, 76.635)
    assert.ok(Math.abs(l.location.lat - 8.913) < 0.1, `${l.name} lat out of range`);
    assert.ok(Math.abs(l.location.lng - 76.635) < 0.1, `${l.name} lng out of range`);
  }
});

test("mandatory entries and aliases from CONTRACTS §7 are present", () => {
  const mens = byName("TKMCE men's hostel");
  const ladies = byName("TKMCE ladies hostel");
  const campus = byName("TKMCE main campus gate");
  assert.ok(mens && ladies && campus, "missing one of the three TKMCE entries");
  for (const a of ["tkmce hostel", "hostel", "mens hostel", "men's hostel", "boys hostel"]) {
    assert.ok(mens.aliases.includes(a), `men's hostel missing alias ${a}`);
  }
  for (const a of ["ladies hostel", "womens hostel", "girls hostel"]) {
    assert.ok(ladies.aliases.includes(a), `ladies hostel missing alias ${a}`);
  }
  for (const a of ["tkmce", "tkm college", "college", "campus", "college gate"]) {
    assert.ok(campus.aliases.includes(a), `campus gate missing alias ${a}`);
  }
  const all = LANDMARKS.flatMap((l) => l.aliases);
  for (const a of ["kadappakada", "chinnakada", "kollam junction", "railway station", "ksrtc", "beach"]) {
    assert.ok(all.includes(a), `table missing alias ${a}`);
  }
});

test("'trapped near TKMCE hostel' → men's hostel (not campus, not ladies hostel)", () => {
  const m = matchLandmark("trapped near TKMCE hostel");
  assert.ok(m, "expected a match");
  assert.equal(m.name, "TKMCE men's hostel");
  assert.equal(m.alias, "tkmce hostel");
  assert.notEqual(m.name, "TKMCE main campus gate");
  assert.notEqual(m.name, "TKMCE ladies hostel");
  assert.deepEqual(m.location, byName("TKMCE men's hostel")!.location);
});

test("'HELP water in house at kadappakada' → Kadappakada", () => {
  const m = matchLandmark("HELP water in house at kadappakada");
  assert.ok(m);
  assert.equal(m.name, "Kadappakada");
});

test("'college gate flooded' → campus gate", () => {
  const m = matchLandmark("college gate flooded");
  assert.ok(m);
  assert.equal(m.name, "TKMCE main campus gate");
  assert.equal(m.alias, "college gate");
});

test("'nothing here' → null; empty / whitespace → null", () => {
  assert.equal(matchLandmark("nothing here"), null);
  assert.equal(matchLandmark(""), null);
  assert.equal(matchLandmark("   "), null);
  assert.equal(matchLandmark("!!! ???"), null);
});

test("whole-word only: 'hostelry' does not match 'hostel'", () => {
  assert.equal(matchLandmark("hostelry"), null);
  assert.equal(matchLandmark("stuck in the hostelry"), null);
  // but the real word still matches
  assert.equal(matchLandmark("stuck in the hostel")?.name, "TKMCE men's hostel");
});

test("case-insensitive and punctuation-insensitive", () => {
  assert.equal(matchLandmark("KADAPPAKADA")?.name, "Kadappakada");
  assert.equal(matchLandmark("KaDaPpAkAdA!!")?.name, "Kadappakada");
  assert.equal(matchLandmark("near TKMCE.")?.name, "TKMCE main campus gate");
  assert.equal(matchLandmark("Men's Hostel, room 12")?.name, "TKMCE men's hostel");
  assert.equal(matchLandmark("men’s hostel")?.name, "TKMCE men's hostel"); // curly apostrophe
  assert.equal(matchLandmark("KSRTC\n\tbus  stand")?.name, "Kollam KSRTC bus stand");
});

test("longest alias wins: ladies hostel beats hostel; tkmce ladies hostel beats tkmce hostel", () => {
  assert.equal(matchLandmark("fire at ladies hostel")?.name, "TKMCE ladies hostel");
  assert.equal(matchLandmark("girls hostel flooded")?.name, "TKMCE ladies hostel");
  assert.equal(matchLandmark("tkmce ladies hostel")?.name, "TKMCE ladies hostel");
  assert.equal(matchLandmark("boys hostel")?.name, "TKMCE men's hostel");
  assert.equal(matchLandmark("kollam junction railway station")?.name, "Kollam Junction railway station");
  assert.equal(matchLandmark("collapsed wall at the beach")?.name, "Kollam beach");
});

test("normaliseLandmarkText", () => {
  assert.equal(normaliseLandmarkText("  Men's   HOSTEL, Gate-2! "), "mens hostel gate 2");
  assert.equal(normaliseLandmarkText("TKMCE"), "tkmce");
});
