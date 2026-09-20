import { test } from "node:test";
import assert from "node:assert/strict";
import { HAZARDS, HAZARD_KINDS, NO_HAZARD, hazardAlertFor, isHazardKind } from "../lib/hazards";
import type { HazardKind } from "../lib/hazards";

// The curated hazard table is the ONLY source of the words a requester sees on the banner
// (README §10 rule 9). These tests pin its shape so the UI and SMS budgets never break.

const TITLE_MAX = 60;
const ACTION_MAX = 160;

test('hazardAlertFor("none") is the NO_HAZARD shape', () => {
  assert.deepEqual(hazardAlertFor("none"), { hasHazard: false, kind: "none", hazardTitle: null, hazardAction: null });
  assert.equal(hazardAlertFor("none"), NO_HAZARD);
  assert.deepEqual(NO_HAZARD, { hasHazard: false, kind: "none", hazardTitle: null, hazardAction: null });
});

test("every real kind maps to its curated title and action", () => {
  for (const kind of HAZARD_KINDS) {
    if (kind === "none") continue;
    const alert = hazardAlertFor(kind);
    assert.equal(alert.hasHazard, true, kind);
    assert.equal(alert.kind, kind);
    assert.equal(alert.hazardTitle, HAZARDS[kind].title);
    assert.equal(alert.hazardAction, HAZARDS[kind].action);
  }
});

test(`every HAZARDS title is ≤ ${TITLE_MAX} chars and every action ≤ ${ACTION_MAX} chars`, () => {
  const kinds = Object.keys(HAZARDS) as Exclude<HazardKind, "none">[];
  assert.equal(kinds.length, HAZARD_KINDS.length - 1); // one entry per kind except "none"
  for (const kind of kinds) {
    const { title, action } = HAZARDS[kind];
    assert.ok(title.trim().length > 0 && title.length <= TITLE_MAX, `${kind} title: ${title.length} chars`);
    assert.ok(action.trim().length > 0 && action.length <= ACTION_MAX, `${kind} action: ${action.length} chars`);
    assert.ok(/^(DANGER|WARNING):/.test(title), `${kind} title must start with DANGER: or WARNING:`);
  }
});

test("isHazardKind accepts the enum and nothing else", () => {
  for (const kind of HAZARD_KINDS) assert.equal(isHazardKind(kind), true, kind);
  assert.equal(isHazardKind("volcano"), false);
  assert.equal(isHazardKind(""), false);
  assert.equal(isHazardKind(null), false);
  assert.equal(isHazardKind(undefined), false);
  assert.equal(isHazardKind(3), false);
  assert.equal(isHazardKind(["gas_leak"]), false);
});
