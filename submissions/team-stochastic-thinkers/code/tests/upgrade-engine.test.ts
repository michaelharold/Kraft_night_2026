process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → rules triage, no model needed
process.env.RESQ_WAVE_WINDOW_MS = "300";
process.env.RESQ_FALLBACK_MS = "60000"; // far away, except in the fallback tests which set their own
delete process.env.TWILIO_ACCOUNT_SID; // SMS must stay simulated
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM;

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resetStoreForTests, getStore } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { accept, cancel, claim, createHelpRequest, payout, resolve, startSearch, tick, tickDueRequests, tplEmergencyContact } from "../lib/waves";
import { capabilityMatch, scoreHelper, selectWave } from "../lib/dispatch";
import { buildDashboard } from "../lib/feed";
import { on } from "../lib/events";
import { recentSms } from "../lib/sms";
import { pricingOf, trustOf } from "../lib/validate";
import { seedHelpers } from "../scripts/seed";
import type { Equipment, Helper, HelpRequest, Skill, TriageResult, TrustTier, UserProfile } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const at = (km: number) => ({ lat: C.lat + km / 111.32, lng: C.lng });
const now = new Date().toISOString();
const T1: TrustTier = "TIER_1_NEIGHBOR", T2: TrustTier = "TIER_2_CERTIFIED_PRO", T3: TrustTier = "TIER_3_FIRST_RESPONDER";
const h = (id: string, km: number, skills: Skill[], extra: Partial<Helper> = {}): Helper =>
  ({ id, name: id, phone: `+9199${id.replace(/\D/g, "").padStart(8, "0").slice(-8)}`, skills, location: at(km), onDuty: true, reliability: 0.7, lastSeen: now, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(helpers: Helper[]) {
  resetStoreForTests(new MemoryStore({ seed: false }));
  for (const x of helpers) await getStore().upsertHelper(x);
}
const pinged = async (id: string, wave?: number) =>
  (await getStore().listDispatches(id)).filter((d) => wave === undefined || d.wave === wave).map((d) => d.helperId).sort();

const NO_HAZARD = { hasHazard: false, kind: "none" as const, hazardTitle: null, hazardAction: null };
const triageOf = (p: Partial<TriageResult>): TriageResult => ({
  type: "flood_rescue", urgency: "high", skills: ["swimmer", "boat_owner", "first_aid"], summary: "test", confidence: 0.9,
  source: "rules", clarifyingQuestion: null, equipment: [], hazardAlert: NO_HAZARD, ...p,
});
/** A request with a fixed triage (independent of the triage module), then dispatch starts. */
async function seeded(t: TriageResult, extra: Partial<HelpRequest> = {}): Promise<HelpRequest> {
  const iso = new Date().toISOString();
  const r = await getStore().createRequest({
    id: randomUUID(), requesterId: "test-uid-01", requesterName: "Anil", requesterPhone: null, requesterHelperId: null, description: "test",
    location: C, locationSource: "gps", landmark: null, channel: "app", role: "self", requesterProfile: null, category: "LIFE_SAFETY",
    gigType: null, calloutFee: 0, escrowStatus: null, triage: t, status: "triaging", wave: 0, radiusKm: 0, waveStartedAt: null,
    matchedHelperId: null, createdAt: iso, updatedAt: iso, ...extra,
  });
  return (await startSearch(r.id)) as HelpRequest;
}
const gig = (description = "Kitchen sink pipe is leaking, need a plumber", fee = 500, requesterHelperId: string | null = null) =>
  createHelpRequest({ requesterId: "acct:req-1", requesterName: "Anil Kumar", requesterPhone: "+919800000001", requesterHelperId, description,
    location: C, locationSource: "gps", landmark: null, channel: "app", category: "HOUSEHOLD_MICROGIG", gigType: "plumbing", calloutFee: fee });
const wallet = async (id: string) => (await getStore().getHelper(id))?.walletBalance ?? 0;

// ── §5 skills + equipment matching ──────────────────────────────────────────────────────────────────────────────

test("capabilityMatch counts skills AND equipment; without equipment the score is the README §5 score", () => {
  const owner = h("a", 0.5, ["counselor"], { equipment: ["water_pump"] });
  const needS: Skill[] = ["swimmer", "boat_owner", "first_aid"], needE: Equipment[] = ["water_pump"];
  assert.equal(capabilityMatch({ helper: owner, neededSkills: needS, neededEquipment: needE }), 1 / 4);
  assert.equal(capabilityMatch({ helper: h("b", 0.5, ["swimmer"], { equipment: ["water_pump"] }), neededSkills: needS, neededEquipment: needE }), 2 / 4);
  assert.equal(capabilityMatch({ helper: h("c", 0.5, ["counselor"]), neededSkills: needS, neededEquipment: needE }), 0);
  assert.equal(capabilityMatch({ helper: owner, neededSkills: [], neededEquipment: [] }), 0);
  const plain = scoreHelper({ helper: h("d", 0.5, ["doctor", "nurse"]), needed: ["doctor", "nurse", "first_aid"], distanceKm: 0.5, radiusKm: 1, now: new Date() });
  assert.ok(Math.abs(plain.score - (0.45 * (2 / 3) + 0.3 * 0.5 + 0.15 * 0.7 + 0.1)) < 1e-9);
  assert.equal(plain.skillMatch, plain.capabilityMatch);
  const withKit = scoreHelper({ helper: owner, needed: needS, neededEquipment: needE, distanceKm: 0.5, radiusKm: 1, now: new Date() });
  assert.equal(withKit.skillMatch, 0);
  assert.ok(Math.abs(withKit.score - (0.45 * 0.25 + 0.3 * 0.5 + 0.15 * 0.7 + 0.1)) < 1e-9);
});

test("selectWave: eligible first, bystanders only fill; strict never fills and needs the skill; requireTier filters", () => {
  const request = { location: C, triage: triageOf({ skills: ["plumber"], equipment: ["water_pump"] }) } as HelpRequest;
  const helpers = [h("near-1", 0.1, ["counselor"]), h("near-2", 0.2, ["counselor"]), h("near-3", 0.3, ["counselor"]),
    h("pump", 0.9, ["counselor"], { equipment: ["water_pump"] }), h("pro", 0.8, ["plumber"], { trustTier: T2 }), h("handy", 0.7, ["plumber"])];
  const base = { request, helpers, radiusKm: 1, excludeHelperIds: new Set<string>(), now: new Date(), neededEquipment: ["water_pump"] as Equipment[] };
  assert.deepEqual(selectWave(base).map((p) => p.helper.id), ["handy", "pro", "pump"], "capable helpers outrank nearer bystanders");
  assert.deepEqual(selectWave({ ...base, helpers: helpers.slice(0, 4) }).map((p) => p.helper.id), ["pump", "near-1", "near-2"], "fill with the nearest others");
  assert.deepEqual(selectWave({ ...base, strict: true, requireTier: T2 }).map((p) => p.helper.id), ["pro"]);
  assert.deepEqual(selectWave({ ...base, strict: true }).map((p) => p.helper.id), ["handy", "pro"], "strict: the pump owner has no trade skill");
  assert.deepEqual(selectWave({ ...base, excludeHelperIds: new Set(["pro"]) }).map((p) => p.helper.id), ["handy", "pump", "near-1"]);
});

test("an equipment-only helper (no matching skill, owns a water pump) is pinged when triage.equipment asks for a pump", async () => {
  await fresh([h("by-1", 0.1, ["counselor"]), h("by-2", 0.2, ["counselor"]), h("by-3", 0.3, ["counselor"]), h("pump-owner", 0.9, ["counselor"], { equipment: ["water_pump"] })]);
  const r = await seeded(triageOf({ equipment: ["water_pump"] }));
  assert.equal(r.status, "searching");
  assert.deepEqual(await pinged(r.id), ["by-1", "by-2", "pump-owner"], "the pump owner is in, the third-nearest bystander is out");
  const body = recentSms().find((m) => m.to === h("pump-owner", 0, []).phone)?.body ?? "";
  assert.match(body, /needs your WATER PUMP/);
  assert.ok(body.length <= 160, `ping is one segment (${body.length})`);

  // Same thing end to end through rules triage ("need pump" → water_pump, docs/UPGRADE.md §5).
  await fresh([h("by-1", 0.1, ["counselor"]), h("by-2", 0.2, ["counselor"]), h("by-3", 0.3, ["counselor"]), h("pump-owner", 0.9, ["counselor"], { equipment: ["water_pump"] })]);
  const e2e = await createHelpRequest({ requesterId: "test-uid-02", requesterPhone: null, requesterHelperId: null, description: "Basement flooded, need pump",
    location: C, locationSource: "gps", landmark: null, channel: "app" });
  assert.ok(e2e.triage?.equipment.includes("water_pump"));
  assert.ok((await pinged(e2e.id)).includes("pump-owner"));
});

// ── §3 trust tiers ──────────────────────────────────────────────────────────────────────────────────────────────

test("wave 1 of a critical life-safety request puts a farther Tier-3 ahead of nearer Tier-1 helpers; wave 2 does not", async () => {
  const med: Skill[] = ["doctor", "nurse", "first_aid"];
  await fresh([h("n1", 0.2, med), h("n2", 0.3, med), h("n3", 0.4, med), h("responder", 0.9, med, { trustTier: T3, credentialId: "KL-112" })]);
  const critical = triageOf({ type: "cardiac_no_breathing", urgency: "critical", skills: med });
  const r = await seeded(critical);
  assert.equal(r.wave, 1);
  const w1 = await getStore().listDispatches(r.id);
  assert.equal(w1[0].helperId, "responder", "Tier 3 is ranked first");
  assert.deepEqual(w1.map((d) => d.helperId).sort(), ["n1", "n2", "responder"]);

  // Not critical → plain score order, even in wave 1.
  await fresh([h("n1", 0.2, med), h("n2", 0.3, med), h("n3", 0.4, med), h("responder", 0.9, med, { trustTier: T3, credentialId: "KL-112" })]);
  assert.deepEqual(await pinged((await seeded({ ...critical, urgency: "high" })).id), ["n1", "n2", "n3"]);

  // Nobody within 1 km → wave 2 (2 km) goes out at once, and there Tier 3 gets no head start.
  await fresh([h("n1", 1.1, med), h("n2", 1.2, med), h("n3", 1.3, med), h("responder", 1.9, med, { trustTier: T3, credentialId: "KL-112" })]);
  const far = await seeded(critical);
  assert.equal(far.wave, 2);
  assert.deepEqual(await pinged(far.id, 2), ["n1", "n2", "n3"]);
});

test("a micro-gig pings only Tier-2 helpers who have the trade skill", async () => {
  await fresh([h("plumber-t2", 0.5, ["plumber"], { trustTier: T2, credentialId: "PL-778" }), h("plumber-t1", 0.2, ["plumber"]),
    h("sparky-t2-pump", 0.3, ["electrician"], { trustTier: T2, credentialId: "EL-101", equipment: ["water_pump"] }),
    h("nurse-t3", 0.1, ["nurse"], { trustTier: T3, credentialId: "NR-9" })]);
  const r = await gig();
  assert.equal(r.category, "HOUSEHOLD_MICROGIG");
  assert.equal(r.gigType, "plumbing");
  assert.equal(r.calloutFee, 500);
  assert.equal(r.escrowStatus, "HELD");
  assert.equal(r.upgradedToLifeSafety, false);
  assert.deepEqual(r.triage?.skills, ["plumber"], "skills come from GIG_TYPES, not from the free text");
  assert.ok(r.triage?.equipment.includes("water_pump"));
  assert.equal(r.triage?.urgency, "medium", "rules said high; a paid job is capped at medium");
  assert.equal(r.status, "searching");
  assert.deepEqual(await pinged(r.id), ["plumber-t2"]);
  const sms = recentSms().find((m) => m.to === h("plumber-t2", 0, []).phone)?.body ?? "";
  assert.match(sms, /paid job .* needs a PLUMBER \(Rs 500 callout/);
  assert.ok(sms.length <= 160);
});

test("claim / accept by someone without the Certified Pro badge → tier_required, the request keeps searching", async () => {
  await fresh([h("plumber-t2", 0.5, ["plumber"], { trustTier: T2, credentialId: "PL-778" }), h("neighbour", 0.2, ["plumber"]), h("doctor-t3", 0.3, ["doctor"], { trustTier: T3, credentialId: "MC-1" })]);
  const r = await gig();
  assert.deepEqual(await claim(r.id, "neighbour"), { ok: false, reason: "tier_required" });
  assert.deepEqual(await claim(r.id, "doctor-t3"), { ok: false, reason: "tier_required" }, "Tier 3 is not a trade licence");
  assert.deepEqual(await claim(r.id, "ghost"), { ok: false, reason: "tier_required" });
  assert.equal((await getStore().getRequest(r.id))?.status, "searching");
  assert.deepEqual(await pinged(r.id), ["plumber-t2"], "a refused claim leaves no dispatch behind");

  // Pinged as a pro, badge withdrawn before answering → accept is refused too, and the ping stays open.
  const d = (await getStore().listDispatches(r.id))[0];
  await getStore().upsertHelper({ ...h("plumber-t2", 0.5, ["plumber"]), trustTier: T1 });
  assert.deepEqual(await accept(d.id), { ok: false, reason: "tier_required" });
  assert.equal((await getStore().getDispatch(d.id))?.status, "pinged");
  await getStore().upsertHelper({ ...h("plumber-t2", 0.5, ["plumber"]), trustTier: T2, credentialId: "PL-778" });
  const ok = await claim(r.id, "plumber-t2");
  assert.equal(ok.ok, true);
  assert.equal((await getStore().getRequest(r.id))?.matchedHelperId, "plumber-t2");

  // Free life-safety requests stay open to everyone.
  const free = await seeded(triageOf({}));
  assert.equal((await claim(free.id, "neighbour")).ok, true);
});

// ── §1 escrow ───────────────────────────────────────────────────────────────────────────────────────────────────

test("escrow: HELD on create → RELEASED on resolve, wallet += fee; a second payout() credits nothing", async () => {
  await fresh([h("pro", 0.5, ["plumber"], { trustTier: T2, credentialId: "PL-778", walletBalance: 200 })]);
  const events: number[] = [];
  const off = on("helper:updated", ({ helper }) => { if (helper.id === "pro") events.push(helper.walletBalance ?? 0); });
  try {
    const r = await gig("Kitchen sink pipe is leaking, need a plumber", 500);
    assert.equal(r.escrowStatus, "HELD");
    assert.deepEqual(await payout(r.id), { ok: false, reason: "not_resolved" }, "searching");
    assert.equal((await claim(r.id, "pro")).ok, true);
    assert.deepEqual(await payout(r.id), { ok: false, reason: "not_resolved" }, "matched, job not done yet");
    assert.equal(await wallet("pro"), 200);

    const done = await resolve(r.id);
    assert.ok(done.ok);
    assert.equal(done.request.status, "resolved");
    assert.equal(done.request.escrowStatus, "RELEASED");
    assert.equal(await wallet("pro"), 700);

    const again = await payout(r.id);
    assert.ok(again.ok);
    assert.deepEqual({ a: again.alreadyReleased, amount: again.amount, helperId: again.helperId, w: again.walletBalance, s: again.escrowStatus },
      { a: true, amount: 500, helperId: "pro", w: 700, s: "RELEASED" });
    assert.equal(await wallet("pro"), 700, "wallet unchanged by the second payout");
    assert.deepEqual(events, [700], "one helper:updated, with the credited balance");
  } finally { off(); }
  assert.deepEqual(await payout("no-such-request"), { ok: false, reason: "not_found" });
});

test("escrow: two concurrent payout() calls credit once; resolve() racing payout() credits once", async () => {
  await fresh([h("pro", 0.5, ["plumber"], { trustTier: T2, credentialId: "PL-778" })]);
  const a = await gig("Kitchen sink pipe is leaking, need a plumber", 1000);
  assert.equal((await claim(a.id, "pro")).ok, true);
  await getStore().updateRequest(a.id, { status: "resolved" }); // resolved but still HELD: only payout() can release it now
  const both = await Promise.all([payout(a.id), payout(a.id), payout(a.id)]);
  assert.ok(both.every((x) => x.ok));
  assert.equal(both.filter((x) => x.ok && !x.alreadyReleased).length, 1, "exactly one call did the release");
  assert.equal(await wallet("pro"), 1000);

  const b = await gig("Bathroom drain is blocked, need a plumber", 200);
  assert.equal((await claim(b.id, "pro")).ok, true);
  const [res, pay] = await Promise.all([resolve(b.id), payout(b.id)]);
  assert.ok(res.ok);
  assert.ok(pay.ok && pay.alreadyReleased, "payout queued behind resolve only reports");
  assert.equal(await wallet("pro"), 1200);

  // Two different jobs for the same pro, released at the same moment: both credits land (helper lock).
  const c = await gig("Need a new washer fitted on the garden tap", 200), d = await gig("Tap in the kitchen keeps dripping", 500);
  for (const x of [c, d]) { await getStore().updateRequest(x.id, { status: "resolved", matchedHelperId: "pro" }); }
  const pair = await Promise.all([payout(c.id), payout(d.id)]);
  assert.ok(pair.every((x) => x.ok && !x.alreadyReleased));
  assert.equal(await wallet("pro"), 1900);
});

test("escrow: cancel refunds a HELD fee; a refunded job can never be paid out", async () => {
  await fresh([h("pro", 0.5, ["plumber"], { trustTier: T2, credentialId: "PL-778" })]);
  const r = await gig();
  assert.equal((await claim(r.id, "pro")).ok, true);
  const c = await cancel(r.id);
  assert.ok(c.ok);
  assert.equal(c.request.status, "cancelled");
  assert.equal(c.request.escrowStatus, "REFUNDED");
  assert.deepEqual(await payout(r.id), { ok: false, reason: "refunded" });
  assert.equal(await wallet("pro"), 0);
});

test("safety override: an 'electrical job' with sparks and a shocked child becomes a FREE life-safety request", async () => {
  const med: Skill[] = ["first_aid"];
  await fresh([h("sparky-t2", 0.5, ["electrician"], { trustTier: T2, credentialId: "EL-101" }), h("neighbour", 0.2, med), h("far-neighbour", 0.6, ["volunteer"])]);
  const r = await createHelpRequest({ requesterId: "acct:req-1", requesterName: "Anil", requesterPhone: "+919800000001", requesterHelperId: null,
    description: "sparks from the meter, my son got a shock", location: C, locationSource: "gps", landmark: null, channel: "app",
    category: "HOUSEHOLD_MICROGIG", gigType: "electrical", calloutFee: 500 });
  assert.equal(r.category, "LIFE_SAFETY");
  assert.equal(r.calloutFee, 0);
  assert.equal(r.escrowStatus, "REFUNDED");
  assert.equal(r.upgradedToLifeSafety, true);
  assert.notEqual(r.triage?.urgency, "medium", "urgency is NOT capped once it is an emergency");
  const ids = await pinged(r.id);
  assert.ok(ids.includes("neighbour") && ids.includes("sparky-t2"), "dispatched like any emergency: tier is not required");
  assert.equal((await claim(r.id, "neighbour")).ok, true, "a Tier-1 neighbour may accept it");
  assert.ok((await resolve(r.id)).ok);
  assert.deepEqual(await payout(r.id), { ok: false, reason: "not_microgig" });
  assert.equal(await wallet("neighbour"), 0);
});

test("a life-safety request is free: fee 0, no escrow; bad pricing input never turns into a paid job", async () => {
  await fresh([h("doc", 0.3, ["doctor"])]);
  const r = await createHelpRequest({ requesterId: "test-uid-03", requesterPhone: null, requesterHelperId: null, description: "father collapsed not breathing",
    location: C, locationSource: "gps", landmark: null, channel: "app" });
  assert.equal(r.category, "LIFE_SAFETY");
  assert.equal(r.calloutFee, 0);
  assert.equal(r.escrowStatus, null);
  assert.equal(r.upgradedToLifeSafety, false);
  assert.deepEqual(await payout(r.id), { ok: false, reason: "not_microgig" });
  for (const gigType of ["toString", "constructor", "__proto__"]) { // inherited keys of GIG_TYPES must not pass as a trade
    const bad = await createHelpRequest({ requesterId: "test-uid-05", requesterPhone: null, requesterHelperId: null, description: "tap is dripping",
      location: C, locationSource: "gps", landmark: null, channel: "app", category: "HOUSEHOLD_MICROGIG", gigType: gigType as never, calloutFee: 500 });
    assert.deepEqual([bad.category, bad.gigType, bad.escrowStatus, bad.status], ["LIFE_SAFETY", null, null, "searching"]);
  }
  const odd = await createHelpRequest({ requesterId: "test-uid-04", requesterPhone: null, requesterHelperId: null, description: "tap is dripping",
    location: C, locationSource: "gps", landmark: null, channel: "app", category: "HOUSEHOLD_MICROGIG", gigType: "plumbing", calloutFee: 123 });
  assert.equal(odd.category, "LIFE_SAFETY");
  assert.equal(odd.escrowStatus, null);
});

// ── §6 3-minute smart fallback ──────────────────────────────────────────────────────────────────────────────────

const PROFILE: UserProfile = { age: 62, bloodGroup: "B+", address: null, medicalNotes: "diabetic", emergencyContactName: "Latha", emergencyContactPhone: "+919812345678" };
const lifeSafety = (contact: string | null = PROFILE.emergencyContactPhone) => createHelpRequest({
  requesterId: "acct:req-9", requesterName: "Anil Kumar", requesterPhone: "+919800000009", requesterHelperId: null,
  description: "father collapsed not breathing", location: C, locationSource: "gps", landmark: null, channel: "app",
  requesterProfile: { ...PROFILE, emergencyContactPhone: contact } });
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const toContact = (phone: string) => recentSms().filter((m) => m.to === phone);

test("fallback: past RESQ_FALLBACK_MS a tick escalates mid-wave, stamps fallbackAt and texts the emergency contact exactly once", async () => {
  await withEnv({ RESQ_FALLBACK_MS: "200", RESQ_WAVE_WINDOW_MS: "100000" }, async () => {
    await fresh([h("doc", 0.3, ["doctor"])]);
    const r = await lifeSafety();
    assert.equal(r.status, "searching");
    assert.equal(r.fallbackAt, null);
    assert.equal((await tick(r.id)).advanced, false, "before the deadline nothing happens (the wave window is 100 s)");
    assert.equal(toContact("+919812345678").length, 0);

    await sleep(250);
    const t = await tick(r.id);
    assert.equal(t.advanced, true);
    assert.equal(t.request?.status, "escalated");
    assert.ok(t.request?.fallbackAt, "fallbackAt set");
    assert.ok(t.request?.emergencyContactNotifiedAt, "emergencyContactNotifiedAt set");
    assert.equal(t.request?.waveStartedAt, null);
    assert.deepEqual((await getStore().listDispatches(r.id)).map((d) => d.status), ["expired"]);

    const sent = toContact("+919812345678");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].body.length <= 160, `one SMS segment (${sent[0].body.length})`);
    assert.match(sent[0].body, /^RESQ: Anil/);
    assert.match(sent[0].body, /asked for emergency help \(cardiac\)/);
    assert.match(sent[0].body, /no local helper has responded/i);
    assert.ok(sent[0].body.includes("https://maps.google.com/?q=8.913000,76.635000"));
    assert.match(sent[0].body, /112\.$/);

    const [a, b] = await Promise.all([tick(r.id), tick(r.id)]);
    assert.equal(a.advanced || b.advanced, false, "a second tick does nothing");
    assert.equal(toContact("+919812345678").length, 1, "still exactly one message");
    assert.equal((await getStore().getRequest(r.id))?.fallbackAt, t.request?.fallbackAt);
    // A neighbour can still take an escalated request from the feed.
    assert.equal((await claim(r.id, "doc")).ok, true);
  });
});

test("fallback: tickDueRequests() honours the deadline; concurrent ticks text once; no contact → no text; micro-gigs are exempt", async () => {
  await withEnv({ RESQ_FALLBACK_MS: "200", RESQ_WAVE_WINDOW_MS: "100000" }, async () => {
    await fresh([h("doc", 0.3, ["doctor"]), h("pro", 0.4, ["plumber"], { trustTier: T2, credentialId: "PL-778" })]);
    const a = await lifeSafety("+919812345600");
    const none = await lifeSafety(null);
    const job = await gig();
    assert.equal(await tickDueRequests(), 0);
    await sleep(250);
    const [n] = await Promise.all([tickDueRequests(), tick(a.id), tick(a.id)]);
    assert.ok(n >= 1);
    const ra = await getStore().getRequest(a.id), rn = await getStore().getRequest(none.id), rj = await getStore().getRequest(job.id);
    assert.equal(ra?.status, "escalated");
    assert.equal(toContact("+919812345600").length, 1);
    assert.equal(rn?.status, "escalated");
    assert.ok(rn?.fallbackAt);
    assert.equal(rn?.emergencyContactNotifiedAt, null);
    assert.equal(rj?.status, "searching", "a paid household job has no 3-minute fallback");
    assert.equal(rj?.fallbackAt, null);
  });
});

test("all 4 waves without an accept → same fallback; a micro-gig that escalates gets no fallbackAt and no text", async () => {
  await fresh([h("far", 50, ["doctor"])]);
  const r = await lifeSafety("+919812345611");
  assert.equal(r.status, "escalated");
  assert.equal(r.wave, 4);
  assert.ok(r.fallbackAt);
  assert.ok(r.emergencyContactNotifiedAt);
  assert.equal(toContact("+919812345611").length, 1);
  const job = await createHelpRequest({ requesterId: "acct:req-9", requesterName: "Anil", requesterPhone: null, requesterHelperId: null,
    description: "Kitchen sink pipe is leaking", location: C, locationSource: "gps", landmark: null, channel: "app",
    requesterProfile: { ...PROFILE, emergencyContactPhone: "+919812345622" }, category: "HOUSEHOLD_MICROGIG", gigType: "plumbing", calloutFee: 200 });
  assert.equal(job.status, "escalated");
  assert.equal(job.fallbackAt, null);
  assert.equal(job.escrowStatus, "HELD", "still claimable from the feed; cancel refunds it");
  assert.equal(toContact("+919812345622").length, 0);
});

test("emergency-contact SMS never exceeds 160 characters", () => {
  const loc = { lat: -33.868812, lng: -151.209312 };
  for (const name of [null, "Anil", "Anil Kumar", "Sreelakshmi Radhakrishnan Nair Puthenveettil", "X".repeat(200)]) {
    for (const type of ["fire", "evacuation_mobility", "cardiac_no_breathing"] as const) {
      for (const location of [loc, null]) {
        const body = tplEmergencyContact({ name, type, location });
        assert.ok(body.length <= 160, `${body.length}: ${body}`);
        assert.match(body, /^RESQ: \S/);
        assert.match(body, /112\.$/);
        if (location) assert.ok(body.includes("https://maps.google.com/?q=-33.868812,-151.209312"), body);
      }
    }
  }
  assert.equal(tplEmergencyContact({ name: "Anil", type: "fire", location: null }),
    "RESQ: Anil asked for emergency help (fire) and no local helper has responded. Location: not shared. Please call them or 112.");
});

// ── feed, validators, seed ──────────────────────────────────────────────────────────────────────────────────────

test("validators: pricingOf and trustOf", () => {
  assert.deepEqual(pricingOf({}), { ok: true, value: { category: "LIFE_SAFETY", gigType: null, calloutFee: 0 } });
  assert.deepEqual(pricingOf({ category: "LIFE_SAFETY", gigType: "plumbing", calloutFee: 500 }), { ok: true, value: { category: "LIFE_SAFETY", gigType: null, calloutFee: 0 } });
  assert.deepEqual(pricingOf({ category: "PAID" }), { ok: false, error: "category_invalid" });
  assert.deepEqual(pricingOf({ category: "HOUSEHOLD_MICROGIG", calloutFee: 500 }), { ok: false, error: "gigType_invalid" });
  assert.deepEqual(pricingOf({ category: "HOUSEHOLD_MICROGIG", gigType: "toString", calloutFee: 500 }), { ok: false, error: "gigType_invalid" });
  for (const calloutFee of [undefined, 0, 10, 501, "500", -200, NaN]) {
    assert.deepEqual(pricingOf({ category: "HOUSEHOLD_MICROGIG", gigType: "plumbing", calloutFee }), { ok: false, error: "calloutFee_invalid" });
  }
  assert.deepEqual(pricingOf({ category: "HOUSEHOLD_MICROGIG", gigType: "electrical", calloutFee: 1000 }),
    { ok: true, value: { category: "HOUSEHOLD_MICROGIG", gigType: "electrical", calloutFee: 1000 } });

  assert.deepEqual(trustOf({}, null), { ok: true, value: { trustTier: T1, credentialId: null } });
  assert.deepEqual(trustOf({}, { trustTier: T2, credentialId: "PL-778" }), { ok: true, value: { trustTier: T2, credentialId: "PL-778" } }, "absent → stored values kept");
  assert.deepEqual(trustOf({ trustTier: "TIER_9" }, null), { ok: false, error: "trustTier_invalid" });
  assert.deepEqual(trustOf({ trustTier: T2 }, null), { ok: false, error: "credentialId_invalid" });
  assert.deepEqual(trustOf({ trustTier: T3, credentialId: "ab" }, null), { ok: false, error: "credentialId_invalid" });
  assert.deepEqual(trustOf({ trustTier: T3, credentialId: "x".repeat(41) }, null), { ok: false, error: "credentialId_invalid" });
  assert.deepEqual(trustOf({ trustTier: T3, credentialId: 12345 }, null), { ok: false, error: "credentialId_invalid" });
  assert.deepEqual(trustOf({ credentialId: null }, { trustTier: T2, credentialId: "PL-778" }), { ok: false, error: "credentialId_invalid" }, "a pro cannot drop the licence number");
  assert.deepEqual(trustOf({ trustTier: T3, credentialId: " KL-MC-4411 " }, null), { ok: true, value: { trustTier: T3, credentialId: "KL-MC-4411" } });
  assert.deepEqual(trustOf({ trustTier: T1, credentialId: "" }, { trustTier: T2, credentialId: "PL-778" }), { ok: true, value: { trustTier: T1, credentialId: null } });
});

test("seed: electrician/plumber → Tier 2, other trades Tier 1; SEED-xx only for Tier 2/3, and no Tier 3 (no medical seeds)", () => {
  const helpers = seedHelpers(C, new Date());
  assert.equal(helpers.length, 30);
  for (const s of helpers) {
    const expected: TrustTier = s.skills.some((k) => k === "doctor" || k === "nurse") ? T3
      : s.skills.some((k) => k === "electrician" || k === "plumber" || k === "generator_owner") ? T2 : T1;
    assert.equal(s.trustTier, expected, s.id);
    if (expected === T1) assert.equal(s.credentialId, null);
    else assert.equal(s.credentialId, `SEED-${s.id.slice(-2)}`);
    assert.equal(s.walletBalance, undefined);
  }
  assert.ok(helpers.some((s) => s.trustTier === T1), "some seeded providers are plain neighbours");
  assert.ok(helpers.some((s) => s.trustTier === T2), "electricians and plumbers are certified pros");
  // seedTier() still awards Tier 3 for doctor/nurse, but no seeded provider holds those skills any more: they
  // stopped being bookable services (lib/taxonomy.ts) and the seed is trades-only. The rule is kept rather than
  // deleted because the emergency triage tables still map need types onto doctor/nurse.
  assert.equal(helpers.filter((s) => s.trustTier === T3).length, 0, "a trades-only seed has no first responders");
});
