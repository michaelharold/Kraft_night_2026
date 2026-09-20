process.env.SEED_ON_BOOT = "0";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // unreachable → translation fails → the relay must still deliver
process.env.RESQ_DATA_FILE = "off";
delete process.env.TWILIO_FROM;                // no number → deliverByCall simulates, which is what we assert on

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore, resetStoreForTests } from "../lib/store";
import { MemoryStore } from "../lib/store/memory";
import { captureVoiceMessage, deliverByCall, getVoiceMessage, gatherSpeech, listVoiceMessages, say, voiceConfigured, voiceXml } from "../lib/voice";
import { languageOf } from "../lib/languages";
import type { Helper, HelpRequest, LanguageCode, Skill } from "../lib/types";

const C = { lat: 8.913, lng: 76.635 };
const now = new Date().toISOString();

const person = (id: string, language: LanguageCode, skills: Skill[] = ["plumber"]): Helper => ({
  id, name: id, phone: `+9190000000${id.slice(-2)}`, skills, location: C, onDuty: true,
  reliability: 0.7, lastSeen: now, language,
});

/** A SERVICE request already accepted by `workerId`. */
async function jobWith(customer: Helper, worker: Helper): Promise<HelpRequest> {
  const store = getStore();
  return store.createRequest({
    id: `req-${customer.id}-${worker.id}`, requesterId: `acct:${customer.id}`, requesterPhone: customer.phone,
    requesterHelperId: customer.id, requesterName: customer.name, requesterProfile: null, role: "self",
    description: "sink leaking", location: C, locationSource: "gps", landmark: null, channel: "app",
    triage: null, status: "matched", wave: 1, radiusKm: 10, waveStartedAt: null, matchedHelperId: worker.id,
    createdAt: now, updatedAt: now, category: "SERVICE", service: "plumber",
  } as HelpRequest);
}

async function fresh(people: Helper[]) {
  resetStoreForTests(new MemoryStore({ seed: false }));
  for (const p of people) await getStore().upsertHelper(p);
}

test("a message is translated into the RECIPIENT's language, not the sender's", async () => {
  const customer = person("cust-01", "ml-IN");
  const worker = person("work-02", "ta-IN");
  await fresh([customer, worker]);
  const job = await jobWith(customer, worker);

  const r = await captureVoiceMessage({
    requestId: job.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "അടുക്കളയിലെ സിങ്ക് ചോരുന്നു", sourceLang: "ml-IN", channel: "app",
  });

  assert.ok(r.ok, "capture should succeed on an accepted job");
  assert.equal(r.message.sourceLang, "ml-IN");
  assert.equal(r.message.targetLang, "ta-IN", "the worker reads Tamil, so that is the target");
  assert.equal(r.message.toHelperId, worker.id);
  assert.equal(r.message.toPhone, worker.phone);
  assert.equal(r.message.seq, 1);
});

test("when translation fails the original survives and the reader is told", async () => {
  const customer = person("cust-03", "ml-IN");
  const worker = person("work-04", "te-IN");
  await fresh([customer, worker]);
  const job = await jobWith(customer, worker);
  const spoken = "പൈപ്പ് പൊട്ടി വെള്ളം നിറയുന്നു";

  const r = await captureVoiceMessage({
    requestId: job.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: spoken, sourceLang: "ml-IN", channel: "call",
  });

  assert.ok(r.ok);
  // Ollama is unreachable in this test file, so this is the real failure path, not a stub.
  assert.equal(r.message.translationSource, "failed");
  assert.equal(r.message.sourceText, spoken, "their own words are never lost");
  assert.equal(r.message.translatedText, spoken, "delivery falls back to the original");
  assert.ok(r.message.translationNote, "and says so, rather than pretending it translated");
});

test("nothing is relayed before someone accepts, and nothing is relayed on a job that does not exist", async () => {
  const customer = person("cust-05", "ml-IN");
  await fresh([customer]);
  const store = getStore();
  const unaccepted = await store.createRequest({
    id: "req-open", requesterId: `acct:${customer.id}`, requesterPhone: customer.phone, requesterHelperId: customer.id,
    requesterName: customer.name, requesterProfile: null, role: "self", description: "sink", location: C,
    locationSource: "gps", landmark: null, channel: "app", triage: null, status: "searching", wave: 1, radiusKm: 10,
    waveStartedAt: now, matchedHelperId: null, createdAt: now, updatedAt: now, category: "SERVICE", service: "plumber",
  } as HelpRequest);

  const pending = await captureVoiceMessage({
    requestId: unaccepted.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "hello", sourceLang: "ml-IN", channel: "call",
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.ok === false && pending.reason, "no_counterpart");

  const ghost = await captureVoiceMessage({
    requestId: "no-such-request", fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "hello", sourceLang: "ml-IN", channel: "call",
  });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.ok === false && ghost.reason, "not_found");

  const empty = await captureVoiceMessage({
    requestId: unaccepted.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "   ", sourceLang: "ml-IN", channel: "call",
  });
  assert.equal(empty.ok === false && empty.reason, "empty");
});

test("a reply runs back the other way and the thread keeps its order", async () => {
  const customer = person("cust-06", "ml-IN");
  const worker = person("work-07", "hi-IN");
  await fresh([customer, worker]);
  const job = await jobWith(customer, worker);

  const first = await captureVoiceMessage({
    requestId: job.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "സിങ്ക് ചോരുന്നു", sourceLang: "ml-IN", channel: "call",
  });
  assert.ok(first.ok);

  const reply = await captureVoiceMessage({
    requestId: job.id, fromRole: "helper", fromHelperId: worker.id, fromPhone: worker.phone,
    sourceText: "मैं दस मिनट में आ रहा हूँ", sourceLang: "hi-IN", channel: "call",
  });
  assert.ok(reply.ok);
  assert.equal(reply.message.targetLang, "ml-IN", "the reply goes back in the customer's language");
  assert.equal(reply.message.toHelperId, customer.id);
  assert.equal(reply.message.seq, 2);

  const thread = listVoiceMessages(job.id);
  assert.equal(thread.length, 2);
  assert.deepEqual(thread.map((m) => m.fromRole), ["requester", "helper"]);
  assert.deepEqual(thread.map((m) => m.seq), [1, 2]);
});

test("the thread is a copy — a caller cannot reach in and rewrite what someone said", async () => {
  const customer = person("cust-08", "ml-IN");
  const worker = person("work-09", "kn-IN");
  await fresh([customer, worker]);
  const job = await jobWith(customer, worker);
  const r = await captureVoiceMessage({
    requestId: job.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "original words", sourceLang: "ml-IN", channel: "app",
  });
  assert.ok(r.ok);

  listVoiceMessages(job.id)[0].sourceText = "tampered";
  r.message.translatedText = "tampered";
  assert.equal(listVoiceMessages(job.id)[0].sourceText, "original words");
  assert.equal(getVoiceMessage(r.message.id)?.translatedText, "original words");
});

test("with no Twilio number, delivery simulates rather than failing", async () => {
  const customer = person("cust-10", "ml-IN");
  const worker = person("work-11", "ta-IN");
  await fresh([customer, worker]);
  const job = await jobWith(customer, worker);
  assert.equal(voiceConfigured(), false, "this suite runs with no TWILIO_FROM");

  const r = await captureVoiceMessage({
    requestId: job.id, fromRole: "requester", fromHelperId: customer.id, fromPhone: customer.phone,
    sourceText: "come quickly", sourceLang: "ml-IN", channel: "app",
  });
  assert.ok(r.ok);
  assert.equal(r.message.status, "captured");

  const d = await deliverByCall(r.message.id);
  assert.deepEqual({ ok: d.ok, simulated: d.simulated }, { ok: true, simulated: true });
  const after = getVoiceMessage(r.message.id);
  assert.equal(after?.status, "delivered");
  assert.equal(after?.deliveryRef, "simulated");
  assert.ok(after?.deliveredAt);

  assert.equal((await deliverByCall("no-such-message")).ok, false);
});

test("TwiML escapes user text and pairs each voice with its own language", () => {
  const xml = voiceXml(say(`Ravi & "Sons" <plumbing>`, "ml-IN"));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>'));
  assert.ok(xml.includes("&amp;") && xml.includes("&quot;") && xml.includes("&lt;plumbing&gt;"));
  assert.ok(!xml.includes("<plumbing>"), "unescaped angle brackets would corrupt the TwiML document");

  for (const code of ["ml-IN", "ta-IN", "kn-IN", "te-IN", "hi-IN", "en-IN"] as LanguageCode[]) {
    const l = languageOf(code);
    const s = say("hello", code);
    assert.ok(s.includes(`voice="${l.voice}"`) && s.includes(`language="${l.sayLang}"`), `${code} mispaired`);
  }
});

test("a speech gather asks Twilio for the right recogniser and never drops a silent caller", () => {
  const g = gatherSpeech({ action: "/api/twilio/voice/message?lang=ta-IN&r=req-1", lang: "ta-IN", prompt: "speak now" });
  assert.ok(g.includes('input="speech"'));
  assert.ok(g.includes('language="ta-IN"'), "the recogniser must match the speaker, not the app default");
  assert.ok(g.includes('speechTimeout="auto"'));
  assert.ok(g.includes('actionOnEmptyResult="true"'), "silence must still reach our handler so we can re-prompt");
  assert.ok(g.includes("&amp;r=req-1"), "the action URL is XML-escaped");
});
