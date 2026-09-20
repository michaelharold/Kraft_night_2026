process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → rules triage, no model needed
process.env.RESQ_WAVE_WINDOW_MS = "300";

import { test } from "node:test";
import assert from "node:assert/strict";
import { resetStoreForTests, getStore } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { accept, createHelpRequest, onReject, tick } from "../lib/waves";
import { scoreHelper } from "../lib/dispatch";
import type { Helper, Skill } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
const now = new Date().toISOString();
const h = (id: string, km: number, skills: Skill[] = ["doctor", "nurse", "first_aid"]): Helper =>
  ({ id, name: id, phone: `+9199${id.padStart(8, "0").slice(-8)}`, skills, location: at(km), onDuty: true, reliability: 0.7, lastSeen: now });

async function fresh(helpers: Helper[]) {
  resetStoreForTests(new MemoryStore({ seed: false }));
  for (const x of helpers) await getStore().upsertHelper(x);
}
const req = (loc = C) => createHelpRequest({ requesterId: "test-uid-01", requesterPhone: null, requesterHelperId: null,
  description: "father collapsed not breathing", location: loc, locationSource: "gps", landmark: null, channel: "app" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("score follows README §5", () => {
  const { score } = scoreHelper({ helper: h("a", 0.5, ["doctor", "nurse"]), needed: ["doctor", "nurse", "first_aid"], distanceKm: 0.5, radiusKm: 1, now: new Date() });
  assert.ok(Math.abs(score - (0.45 * (2 / 3) + 0.3 * 0.5 + 0.15 * 0.7 + 0.1)) < 1e-9);
});

test("wave 1 pings the 3 best within 1 km; tick widens to 2 km", async () => {
  await fresh([h("h1", 0.3), h("h2", 0.6), h("h3", 0.9), h("h4", 0.95), h("h5", 1.5)]);
  const r = await req();
  assert.equal(r.status, "searching");
  assert.equal(r.wave, 1);
  const w1 = await getStore().listDispatches(r.id);
  assert.deepEqual(w1.map((d) => d.helperId).sort(), ["h1", "h2", "h3"]);
  assert.equal((await tick(r.id)).advanced, false);
  await sleep(350);
  const [a, b] = await Promise.all([tick(r.id), tick(r.id)]);
  assert.equal([a, b].filter((x) => x.advanced).length, 1, "concurrent ticks advance once");
  const after = await getStore().listDispatches(r.id);
  assert.equal(after.filter((d) => d.wave === 1 && d.status === "expired").length, 3);
  assert.deepEqual(after.filter((d) => d.wave === 2).map((d) => d.helperId).sort(), ["h4", "h5"]);
});

test("concurrent accepts: exactly one wins, the rest are cancelled", async () => {
  await fresh([h("h1", 0.3), h("h2", 0.6), h("h3", 0.9)]);
  const r = await req();
  const ds = await getStore().listDispatches(r.id);
  const res = await Promise.all(ds.map((d) => accept(d.id)));
  assert.equal(res.filter((x) => x.ok).length, 1);
  const final = await getStore().getRequest(r.id);
  assert.equal(final?.status, "matched");
  assert.equal((await getStore().listDispatches(r.id)).filter((d) => d.status === "cancelled").length, 2);
});

test("one reject never back-fills; all rejected → next wave immediately", async () => {
  await fresh([h("h1", 0.3), h("h2", 0.6), h("h3", 0.9), h("h4", 1.5)]);
  const r = await req();
  const ds = await getStore().listDispatches(r.id);
  await onReject(ds[0].id);
  assert.equal((await getStore().listDispatches(r.id)).length, 3);
  await onReject(ds[1].id);
  await onReject(ds[2].id);
  const now2 = await getStore().getRequest(r.id);
  assert.equal(now2?.wave, 2);
  assert.ok((await getStore().listDispatches(r.id)).some((d) => d.helperId === "h4" && d.status === "pinged"));
});

test("nobody within 8 km → escalated at wave 4; no location → escalated at wave 0", async () => {
  await fresh([h("far", 50)]);
  const r = await req();
  assert.equal(r.status, "escalated");
  assert.equal(r.wave, 4);
  const n = await createHelpRequest({ requesterId: "test-uid-02", requesterPhone: null, requesterHelperId: null,
    description: "help", location: null, locationSource: "none", landmark: null, channel: "app" });
  assert.equal(n.status, "escalated");
  assert.equal(n.wave, 0);
});
