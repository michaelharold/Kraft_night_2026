/**
 * Voice alert calls (lib/voice.ts §"Outbound alert calls" + the wiring in lib/waves.ts). When a help request
 * matches a helper's skill the SMS already lands (lib/sms.ts); the call is the ringtone that makes them notice it
 * soon and reply. A call costs real money, so it rings only genuine matches — a skill, or a piece of equipment the
 * request asks for — while a bystander who merely fills a wave still gets the text, never a call.
 */
process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → rules triage, no model needed
process.env.RESQ_DATA_FILE = "off";
delete process.env.TWILIO_ACCOUNT_SID; // no Twilio in tests → deliverAlertCall simulates and logs to recentAlertCalls
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM;
delete process.env.TWILIO_API_KEY_SID;
delete process.env.TWILIO_API_KEY_SECRET;

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { alertPing, alertScoped, alertService, deliverAlertCall, recentAlertCalls } from "../lib/voice";
import { recentSms } from "../lib/sms";
import { startSearch, createServiceRequest } from "../lib/waves";
import type { Equipment, Helper, HelpRequest, Skill, TriageResult } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
const now = new Date().toISOString();
const h = (id: string, km: number, skills: Skill[], extra: Partial<Helper> = {}): Helper =>
  ({ id, name: id, phone: `+9198${id.replace(/\D/g, "").padStart(8, "0").slice(-8)}`, skills, location: at(km), onDuty: true, reliability: 0.7, lastSeen: now, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(helpers: Helper[]) {
  resetStoreForTests(new MemoryStore({ seed: false }));
  for (const x of helpers) await getStore().upsertHelper(x);
}
const NO_HAZARD = { hasHazard: false, kind: "none" as const, hazardTitle: null, hazardAction: null };
const triageOf = (p: Partial<TriageResult>): TriageResult => ({
  type: "flood_rescue", urgency: "high", skills: ["swimmer", "boat_owner", "first_aid"], summary: "test", confidence: 0.9,
  source: "rules", clarifyingQuestion: null, equipment: [], hazardAlert: NO_HAZARD, ...p,
});
/** A request with a fixed triage (independent of the triage module), then dispatch starts. */
async function seeded(t: TriageResult): Promise<HelpRequest> {
  const iso = new Date().toISOString();
  const r = await getStore().createRequest({
    id: randomUUID(), requesterId: "test-uid-01", requesterName: "Anil", requesterPhone: null, requesterHelperId: null, description: "test",
    location: C, locationSource: "gps", landmark: null, channel: "app", role: "self", requesterProfile: null, category: "LIFE_SAFETY",
    gigType: null, calloutFee: 0, escrowStatus: null, triage: t, status: "triaging", wave: 0, radiusKm: 0, waveStartedAt: null,
    matchedHelperId: null, createdAt: iso, updatedAt: iso,
  });
  return (await startSearch(r.id)) as HelpRequest;
}

test("without Twilio credentials an alert call is simulated, logged and never throws", async () => {
  const r = await deliverAlertCall("+14254843703", alertPing({ distanceKm: 0.1, skill: "plumber" }), "en-IN");
  assert.deepEqual(r, { ok: true, simulated: true });
  const log = recentAlertCalls().find((c) => c.to === "+14254843703");
  assert.ok(log, "the simulated call is in the log");
  assert.equal(log?.simulated, true);
  assert.match(log?.text ?? "", /plumber help request/);
  assert.equal(log?.lang, "en-IN");
});

test("spoken alert templates are short enough to say in one breath and name the service", () => {
  const ping = alertPing({ distanceKm: 0.3, skill: "plumber" });
  assert.match(ping, /A plumber help request/);
  assert.ok(ping.length <= 220, `ping is ${ping.length}`);

  const generic = alertPing({ distanceKm: 0.3 });
  assert.match(generic, /matching your skills/);

  const svc = alertService({ service: "electrician", distanceKm: 2.5 });
  assert.match(svc, /new electrician job/);
  assert.ok(svc.length <= 220, `service is ${svc.length}`);

  const sc = alertScoped({ category: "plumber", distanceKm: 0.7 });
  assert.match(sc, /reply ACCEPT/);
  assert.ok(sc.length <= 220, `scoped is ${sc.length}`);
});

test("a service broadcast pairs SMS with a call to skill-matched providers only", async () => {
  await fresh([
    h("leela", 0, [], { phone: "+919800000001" }),
    h("plumberNear", 0.5, ["plumber"], { phone: "+919800000011" }),
    h("electrician", 0.4, ["electrician"], { phone: "+919800000012" }),
  ]);
  const leela = (await getStore().getHelper("leela"))!;
  await createServiceRequest({ service: "plumber", description: "Kitchen sink pipe is leaking", location: C, account: leela });
  await sleep(20); // deliverAlertCall is fire-and-forget, like sendSms

  const p = "+919800000011", e = "+919800000012";
  assert.ok(recentSms().some((m) => m.to === p && /New plumber job/.test(m.body)), "the plumber gets the SMS");
  assert.ok(recentAlertCalls().some((c) => c.to === p), "and the plumber gets the call");
  assert.ok(recentAlertCalls().every((c) => c.to !== e), "the electrician is called for no plumber job");
});

test("wave pings call a skill/equipment-matched helper, never a bystander who just fills the wave", async () => {
  await fresh([
    h("by-1", 0.1, ["counselor"]), h("by-2", 0.2, ["counselor"]), h("by-3", 0.3, ["counselor"]),
    h("pump-owner", 0.9, ["counselor"], { equipment: ["water_pump"] as Equipment[] }),
  ]);
  const r = await seeded(triageOf({ skills: ["plumber"], equipment: ["water_pump"] }));
  await sleep(20);

  const pump = h("pump-owner", 0, []).phone, b1 = h("by-1", 0, []).phone, b2 = h("by-2", 0, []).phone;
  assert.equal(r.status, "searching");
  assert.ok(recentAlertCalls().some((c) => c.to === pump), "the pump owner (equipment match) is called");
  assert.ok(recentAlertCalls().every((c) => c.to !== b1 && c.to !== b2), "bystander fills are texted, not called");
  assert.ok(recentSms().some((m) => m.to === b1 && /Reply YES/.test(m.body)), "the bystander still gets the ping text");
});