process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
process.env.RESQ_WAVE_WINDOW_MS = "100000";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { cancel, claim, createHelpRequest, onReject, resolve } from "../lib/waves";
import { recentSms } from "../lib/sms";
import type { Helper } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
const helper = (id: string, km: number, phone: string): Helper => ({ id, name: id, phone, skills: ["doctor", "nurse", "first_aid"], location: at(km),
  onDuty: true, reliability: 0.7, lastSeen: new Date().toISOString() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closureTexts = (phone: string) => recentSms().filter((m) => m.to === phone && /No action needed/.test(m.body));

async function setup() {
  resetStoreForTests(new MemoryStore({ seed: false }));
  for (const h of [helper("a", 0.2, "+919100000001"), helper("b", 0.4, "+919100000002"), helper("c", 0.6, "+919100000003")]) await getStore().upsertHelper(h);
  return createHelpRequest({ requesterId: "test-uid-closure", requesterPhone: null, requesterHelperId: null,
    description: "father collapsed not breathing", location: C, locationSource: "gps", landmark: null, channel: "app" });
}

test("done: every pinged helper except the one who helped (and those who declined) is told no action is needed", async () => {
  const r = await setup();
  const ds = await getStore().listDispatches(r.id);
  assert.equal(ds.length, 3);
  await onReject(ds.find((d) => d.helperId === "c")!.id);               // c declined: gets nothing
  assert.equal((await claim(r.id, "a")).ok, true);                     // a helps
  assert.equal((await resolve(r.id)).ok, true);
  await sleep(50);
  assert.equal(closureTexts("+919100000001").length, 0, "the helper who did the job is not told");
  assert.equal(closureTexts("+919100000002").length, 1, "a pinged helper who never answered is told once");
  assert.equal(closureTexts("+919100000003").length, 0, "a helper who declined is not bothered again");
  assert.match(closureTexts("+919100000002")[0].body, /resolved/);
});

test("cancel: pinged helpers are told it was cancelled", async () => {
  const r = await setup();
  assert.equal((await cancel(r.id)).ok, true);
  await sleep(50);
  const t = recentSms().filter((m) => /cancelled\. No action needed/.test(m.body));
  assert.ok(t.length >= 3);
});

test("one job at a time: a helper on a job is not pinged for new requests and cannot take a second one", async () => {
  const r1 = await setup();
  assert.equal((await claim(r1.id, "a")).ok, true);
  const r2 = await createHelpRequest({ requesterId: "test-uid-closure-2", requesterPhone: null, requesterHelperId: null,
    description: "deep cut bleeding a lot", location: C, locationSource: "gps", landmark: null, channel: "app" });
  const pinged = (await getStore().listDispatches(r2.id)).map((d) => d.helperId);
  assert.ok(!pinged.includes("a"), "busy helper is not pinged");
  const second = await claim(r2.id, "a");
  assert.equal(second.ok, false);
  assert.equal(second.ok ? null : second.reason, "busy");
  assert.equal((await resolve(r1.id)).ok, true);
  assert.equal((await claim(r2.id, "a")).ok, true, "after Mark as done they can take the next one");
});
