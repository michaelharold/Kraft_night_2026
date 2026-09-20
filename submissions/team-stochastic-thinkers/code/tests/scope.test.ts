import { test } from "node:test";
import assert from "node:assert/strict";
import { ScopeError, normalizeScope, scopeSchema } from "../lib/scope";
import { tplScopedJob } from "../lib/sms";

test("AI output is clamped to the shared vocabularies; the tapped service wins", () => {
  const s = normalizeScope({
    parsedTitle: "Fix leaking kitchen sink pipe joint under the cabinet — very long title that goes on",
    category: "carpenter", urgencyScore: 42, estimatedTimeMinutes: 3, requiredTools: ["pipe_wrench", "laser_cannon", "pipe_wrench", "plunger"],
    skillLevelRequired: "wizard", workerMatchingTags: ["carpenter", "painter"], steps: ["Shut the valve", "", "Replace washer"],
    photoRequests: [{ what: "Leaking joint", angle: "close-up from underneath", why: "size of fitting" }, { what: "", angle: "x", why: "y" }],
    questions: ["Metal or PVC?"],
  }, "test-model", "plumber");
  assert.equal(s.category, "plumber", "the service the user tapped wins over the model's guess");
  assert.deepEqual(s.workerMatchingTags, ["plumber"], "no extra trades when the user chose one");
  assert.equal(s.urgencyScore, 10);
  assert.equal(s.estimatedTimeMinutes, 10);
  assert.deepEqual(s.requiredTools, ["pipe_wrench", "plunger"], "unknown tools dropped, duplicates removed");
  assert.equal(s.skillLevelRequired, "intermediate");
  assert.equal(s.parsedTitle.length <= 60, true);
  assert.deepEqual(s.steps, ["Shut the valve", "Replace washer"]);
  assert.equal(s.photoRequests.length, 1, "photo requests without a subject are dropped");
  assert.equal(s.model, "test-model");
});

test("garbage from the model is rejected; a missing photo list gets a sensible default", () => {
  assert.throws(() => normalizeScope("not json", "m", null), ScopeError);
  assert.throws(() => normalizeScope({ category: "wizard" }, "m", null), ScopeError);
  const s = normalizeScope({ category: "electrician" }, "m", null);
  assert.equal(s.photoRequests.length, 1);
  assert.deepEqual(s.workerMatchingTags, ["electrician"]);
});

test("schema forces the required keys", () => {
  const sc = scopeSchema() as { required: string[] };
  for (const k of ["parsedTitle", "category", "urgencyScore", "estimatedTimeMinutes", "requiredTools", "skillLevelRequired", "workerMatchingTags", "photoRequests", "questions"]) assert.ok(sc.required.includes(k), k);
});

test("SMS job alert matches the spec and stays short", () => {
  const m = tplScopedJob({ category: "Plumber", title: "Fix leaking sink", minutes: 45, tools: ["Pipe wrench", "Plunger"], code: "0361", distanceKm: 0.7 });
  assert.equal(m, "Sahaya: Plumber job 700 m away. Fix leaking sink. About 45 min. Bring: Pipe wrench, Plunger. Reply ACCEPT 0361 to take it.");
  assert.ok(tplScopedJob({ category: "Plumber", title: "x".repeat(200), minutes: 45, tools: Array(20).fill("Pipe wrench"), code: "0361", distanceKm: 1 }).length <= 320);
});
