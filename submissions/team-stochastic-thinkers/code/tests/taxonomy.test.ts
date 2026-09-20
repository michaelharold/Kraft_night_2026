import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILLS, NEED_TYPES, TYPE_SKILLS, isSkill, isNeedType, isUrgency } from "../lib/taxonomy";

test("taxonomy sizes match README §4", () => {
  assert.equal(SKILLS.length, 18);
  assert.equal(NEED_TYPES.length, 12);
});

test("every need type has at least one valid default skill", () => {
  for (const t of NEED_TYPES) {
    assert.ok(TYPE_SKILLS[t].length >= 1, `${t} has no default skills`);
    for (const s of TYPE_SKILLS[t]) assert.ok(isSkill(s), `${t}: ${s} is not a skill`);
  }
});

test("guards reject junk", () => {
  assert.equal(isSkill("wizard"), false);
  assert.equal(isNeedType(42), false);
  assert.equal(isUrgency(null), false);
  assert.equal(isUrgency("critical"), true);
});
