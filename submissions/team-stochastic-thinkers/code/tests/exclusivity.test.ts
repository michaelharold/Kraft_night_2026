/**
 * One job, one worker. The engine has always been atomic about this — store.acceptDispatch flips the request to
 * "matched" and cancels the other dispatches under the request lock — but "exclusive" has to mean the same thing on
 * every surface the job appeared on, and the surfaces are not the same shape. A provider with the app open finds
 * out because lib/feed.ts only lists "searching" requests; a provider who was alerted by SMS finds out only if we
 * text them, which is the half that was missing.
 *
 * So these tests take one accepted job and ask both questions at once: is it gone from the other providers' feeds,
 * and did the other providers' phones hear about it — exactly once, and not the winner's phone. The SMS sink is the
 * simulated one (no Twilio credentials in tests → sendSms logs and records), read back through recentSms(). That
 * log is one process-wide ring buffer with no reset, so each test hands out its own phone numbers rather than
 * counting somebody else's texts.
 */
process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → rules triage, no model needed

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { buildDashboard } from "../lib/feed";
import { claim, createServiceRequest, decline } from "../lib/waves";
import { recentSms } from "../lib/sms";
import type { Helper, Skill } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
type Who = "p1" | "p2" | "p3" | "p4" | "asha" | "binu";
const ORDER: Who[] = ["p1", "p2", "p3", "p4", "asha", "binu"];
const phonesFor = (run: number) => Object.fromEntries(ORDER.map((w, i) => [w, `+9193${run}000000${i + 1}`])) as Record<Who, string>;
const person = (id: Who, km: number, skills: Skill[], phone: string): Helper => ({
  id, name: id, phone, skills, location: at(km), onDuty: true, reliability: 0.8, lastSeen: new Date().toISOString(),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The "job is gone" texts this worker's phone received. */
const takenTexts = (phone: string) => recentSms().filter((m) => m.to === phone && /has just been taken/.test(m.body));

/** Four plumbers around a customer (asha) who books one job, plus a second customer (binu) whose job stays open. */
async function world(run: number) {
  const ph = phonesFor(run);
  resetStoreForTests(new MemoryStore({ seed: false }));
  const s = getStore();
  for (const h of [person("p1", 0.3, ["plumber"], ph.p1), person("p2", 0.6, ["plumber"], ph.p2),
    person("p3", 0.9, ["plumber"], ph.p3), person("p4", 1.2, ["plumber"], ph.p4),
    person("asha", 0, [], ph.asha), person("binu", 0.1, [], ph.binu)]) await s.upsertHelper(h);
  const asha = (await s.getHelper("asha"))!;
  const binu = (await s.getHelper("binu"))!;
  const taken = await createServiceRequest({ service: "plumber", description: "Bathroom pipe burst, water everywhere", location: C, account: asha });
  const open = await createServiceRequest({ service: "plumber", description: "Kitchen tap drips all night", location: C, account: binu });
  return { taken, open, ph };
}

test("once one provider accepts, the job leaves every other provider's feed; unrelated jobs stay", async () => {
  const { taken, open, ph } = await world(1);
  const before = await buildDashboard("p2", ph.p2);
  assert.deepEqual(before.feed.map((f) => f.request.id).sort(), [taken.id, open.id].sort(), "both jobs are on offer to start with");

  assert.equal((await claim(taken.id, "p1")).ok, true);

  for (const other of ["p2", "p3", "p4"] as const) {
    const d = await buildDashboard(other, ph[other]);
    assert.deepEqual(d.feed.map((f) => f.request.id), [open.id], `${other} sees only the job that is still open`);
    assert.equal(d.hiddenWhileBusy, 0, `${other} is not on a job, so nothing is hidden from them`);
  }
  const winner = await buildDashboard("p1", ph.p1);
  assert.equal(winner.active?.request.id, taken.id, "the winner is on the job");
  assert.deepEqual(winner.feed, [], "and sees nothing else until they mark it done");

  const stored = await getStore().getRequest(taken.id);
  assert.equal(stored?.status, "matched");
  assert.equal(stored?.matchedHelperId, "p1");
});

test("every other alerted provider is texted once that the job is taken; the winner and anyone who declined are not", async () => {
  const { taken, ph } = await world(2);
  await decline(taken.id, "p4"); // said "not now" before the accept: do not text them about it again

  assert.equal((await claim(taken.id, "p1")).ok, true);
  await sleep(50); // notifyTaken is fire-and-forget, deliberately not awaited by accept

  assert.equal(takenTexts(ph.p2).length, 1, "a provider who was alerted is told exactly once");
  assert.equal(takenTexts(ph.p3).length, 1);
  assert.equal(takenTexts(ph.p1).length, 0, "the provider who took the job is not told it was taken");
  assert.equal(takenTexts(ph.p4).length, 0, "somebody who already declined is not bothered again");
  assert.equal(takenTexts(ph.asha).length, 0, "the customer gets the match text, not a job-taken notice");

  const body = takenTexts(ph.p2)[0].body;
  assert.match(body, /Plumber job/, "says which job, so it is obvious which text it answers");
  assert.match(body, /text you the next one/, "points forward");
  assert.ok(body.length <= 160, `one SMS segment (${body.length})`);
  assert.ok(!/sorry|reject|not selected|unsuccessful/i.test(body), "never reads as a rejection of the worker");
});

test("a second provider accepting the same job is refused with already_matched", async () => {
  const { taken } = await world(3);
  assert.equal((await claim(taken.id, "p1")).ok, true);

  const second = await claim(taken.id, "p3");
  assert.equal(second.ok, false);
  assert.equal(second.ok ? null : second.reason, "already_matched");
  assert.equal((await getStore().getRequest(taken.id))?.matchedHelperId, "p1", "the first acceptance stands");
});
