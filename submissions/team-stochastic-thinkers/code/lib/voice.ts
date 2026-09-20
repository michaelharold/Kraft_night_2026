/**
 * The voice relay: how two people who share no language, one of whom may have no smartphone at all, hold a
 * conversation about a leaking pipe.
 *
 * A turn is always the same five steps, whether it started in the app or on a phone call:
 *
 *   1. CAPTURE   the speaker's words as text, in their own language.
 *                In the app that is the browser's speech recognition (components/VoiceMic.tsx, already there).
 *                On a call it is Twilio's <Gather input="speech" language="ml-IN">, which returns a transcript
 *                live — Twilio's transcription of a *recording* does not cover Malayalam or Tamil, so gathering
 *                is not a shortcut, it is the only route that works for these languages.
 *   2. RECORD    the original audio alongside it, best-effort. The recipient can play the real voice when a name
 *                or a house number looks wrong in the transcript. If recording fails the relay carries on.
 *   3. TRANSLATE into the recipient's language with the local model (lib/translate.ts). A failure here is
 *                delivered, not swallowed: the recipient gets the original plus a plain note saying so.
 *   4. DELIVER   by calling the recipient and reading the translation out with a Google TTS voice in their own
 *                language, or — when they are in the app — simply showing it on their screen.
 *   5. REPLY     the recipient speaks back and the whole thing runs in reverse.
 *
 * Neither end needs data. The requester needs a phone line; the worker needs a phone line. That is the point:
 * the "offline" worker whose income this protects is the same person who cannot be expected to read Malayalam.
 *
 * Messages live in memory beside the requests they belong to (lib/waves.ts holds its declines the same way).
 * They are conversation about one open job, not a durable record of money, and a request does not survive a
 * restart either — so neither should its chatter. The audio itself lives at Twilio.
 */
import { randomUUID } from "node:crypto";
import { emit } from "./events";
import { DEFAULT_LANGUAGE, MAX_SPEECH_SECONDS, languageOf, type LanguageCode } from "./languages";
import { getStore } from "./store";
import { translate } from "./translate";
import { getTwilio, twilioAuthConfigured } from "./twilio";
import type { HelpRequest, VoiceMessage } from "./types";

const g = globalThis as unknown as { __resq_voice?: Map<string, VoiceMessage[]> };
/** requestId -> the turns so far, oldest first. */
const threads: Map<string, VoiceMessage[]> = (g.__resq_voice ??= new Map());

export const voiceConfigured = (): boolean => twilioAuthConfigured() && !!process.env.TWILIO_FROM?.trim();

const publicBase = () => (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

/**
 * The spoken translation of each message, kept beside the thread rather than on it: audio is ~100 KB a turn and
 * a VoiceMessage gets serialised into every SSE snapshot, so putting it on the record would push a megabyte of
 * base64 down the wire on every unrelated dashboard change.
 *
 * Bounded and oldest-first-evicted. Losing the audio of an old turn costs nothing — the text is still there, and
 * the recipient has long since heard it.
 */
const ga = globalThis as unknown as { __resq_voice_audio?: Map<string, Buffer> };
const spoken: Map<string, Buffer> = (ga.__resq_voice_audio ??= new Map());
const SPOKEN_MAX = 40;

export function putSpokenAudio(messageId: string, wav: Buffer): void {
  if (spoken.size >= SPOKEN_MAX) spoken.delete(spoken.keys().next().value as string);
  spoken.set(messageId, wav);
  mutate(messageId, { hasSpokenAudio: true });   // the flag rides the SSE snapshot; the bytes do not
}
export const getSpokenAudio = (messageId: string): Buffer | null => spoken.get(messageId) ?? null;

export function listVoiceMessages(requestId: string): VoiceMessage[] {
  return (threads.get(requestId) ?? []).map((m) => ({ ...m }));
}

export function getVoiceMessage(id: string): VoiceMessage | null {
  for (const thread of threads.values()) {
    const hit = thread.find((m) => m.id === id);
    if (hit) return { ...hit };
  }
  return null;
}

function mutate(id: string, patch: Partial<VoiceMessage>): VoiceMessage | null {
  for (const thread of threads.values()) {
    const hit = thread.find((m) => m.id === id);
    if (hit) { Object.assign(hit, patch); return { ...hit }; }
  }
  return null;
}

/** The language a person reads, falling back to the app default rather than to whatever the last caller chose. */
export async function languageForHelper(helperId: string | null): Promise<LanguageCode> {
  if (!helperId) return DEFAULT_LANGUAGE;
  const h = await getStore().getHelper(helperId);
  return languageOf(h?.language).code;
}

/** The language a caller reads, looked up by the number they are calling from. null when we have never met them. */
export async function languageForPhone(phone: string): Promise<LanguageCode | null> {
  const h = await getStore().getHelperByPhone(phone);
  return h?.language ? languageOf(h.language).code : null;
}

/**
 * Who should hear this turn. The requester talks to whoever accepted the job; the worker talks to the requester.
 * Returns null before anyone has accepted — there is nobody to relay to yet, and the message is held on the
 * request as its description instead of being queued into the void.
 */
async function counterpart(r: HelpRequest, fromRole: "requester" | "helper") {
  const store = getStore();
  if (fromRole === "requester") {
    if (!r.matchedHelperId) return null;
    const h = await store.getHelper(r.matchedHelperId);
    return h ? { helperId: h.id, phone: h.phone, lang: languageOf(h.language).code } : null;
  }
  const requester = r.requesterHelperId ? await store.getHelper(r.requesterHelperId) : null;
  const phone = requester?.phone ?? r.requesterPhone;
  if (!phone) return null;
  return { helperId: requester?.id ?? null, phone, lang: languageOf(requester?.language).code };
}

export type CaptureInput = {
  requestId: string;
  fromRole: "requester" | "helper";
  fromHelperId: string | null;
  fromPhone: string | null;
  sourceText: string;
  sourceLang: LanguageCode;
  channel: "app" | "call";
  recordingUrl?: string | null;
  recordingSec?: number | null;
};

export type CaptureResult =
  | { ok: true; message: VoiceMessage }
  | { ok: false; reason: "not_found" | "no_counterpart" | "empty" };

/**
 * Steps 1–3: take what someone said, translate it for the other side, and put it in the thread. Delivery is
 * kicked off separately so a slow outbound call never holds up the webhook that Twilio is waiting on.
 */
export async function captureVoiceMessage(input: CaptureInput): Promise<CaptureResult> {
  const text = (input.sourceText ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };

  const request = await getStore().getRequest(input.requestId);
  if (!request) return { ok: false, reason: "not_found" };

  const to = await counterpart(request, input.fromRole);
  if (!to) return { ok: false, reason: "no_counterpart" };

  const t = await translate({ text, from: input.sourceLang, to: to.lang });

  const thread = threads.get(input.requestId) ?? [];
  const message: VoiceMessage = {
    id: randomUUID(),
    requestId: input.requestId,
    seq: thread.length + 1,
    fromRole: input.fromRole,
    fromHelperId: input.fromHelperId,
    fromPhone: input.fromPhone,
    toHelperId: to.helperId,
    toPhone: to.phone,
    sourceLang: input.sourceLang,
    targetLang: to.lang,
    sourceText: text,
    translatedText: t.text,
    translationSource: t.source,
    translationNote: t.note,
    channel: input.channel,
    recordingUrl: input.recordingUrl ?? null,
    recordingSec: input.recordingSec ?? null,
    status: "captured",
    deliveryRef: null,
    error: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  };
  thread.push(message);
  threads.set(input.requestId, thread);
  emit("request:updated", { request });
  return { ok: true, message: { ...message } };
}

/** Attach the recording once Twilio finishes writing it; the message is already delivered by then. */
export function attachRecording(messageId: string, url: string, seconds: number | null): VoiceMessage | null {
  return mutate(messageId, { recordingUrl: url, recordingSec: seconds });
}

/**
 * Step 4. Rings the recipient and, when they pick up, /api/twilio/voice/deliver reads the translation out in
 * their language and gathers their reply.
 *
 * Without a Twilio number (the current state of this account) it logs the call it would have placed and marks the
 * message delivered, so the whole relay is demonstrable end to end with no phone and no credit. Setting
 * TWILIO_FROM is the only change needed to make these real calls.
 */
export async function deliverByCall(messageId: string): Promise<{ ok: boolean; simulated: boolean; error?: string }> {
  const m = getVoiceMessage(messageId);
  if (!m) return { ok: false, simulated: false, error: "not_found" };
  if (!m.toPhone) { mutate(messageId, { status: "failed", error: "no_number" }); return { ok: false, simulated: false, error: "no_number" }; }

  mutate(messageId, { status: "delivering" });
  const spoken = languageOf(m.targetLang);

  if (!voiceConfigured() || !publicBase()) {
    const why = !voiceConfigured() ? "no TWILIO_FROM" : "no PUBLIC_BASE_URL";
    console.log(`[voice:simulated] to=${m.toPhone} lang=${m.targetLang} voice=${spoken.voice} (${why}) say="${m.translatedText}"`);
    mutate(messageId, { status: "delivered", deliveryRef: "simulated", deliveredAt: new Date().toISOString() });
    const r = await getStore().getRequest(m.requestId);
    if (r) emit("request:updated", { request: r });
    return { ok: true, simulated: true };
  }

  try {
    const call = await (await getTwilio()).calls.create({
      to: m.toPhone,
      from: process.env.TWILIO_FROM!,
      url: `${publicBase()}/api/twilio/voice/deliver?m=${encodeURIComponent(messageId)}`,
      method: "POST",
      // The original audio is the fallback when a transcript reads wrong, so keep the reply leg recorded too.
      record: true,
      recordingStatusCallback: `${publicBase()}/api/twilio/voice/recording?m=${encodeURIComponent(messageId)}`,
      recordingStatusCallbackMethod: "POST",
      timeLimit: 300,
    });
    mutate(messageId, { status: "delivered", deliveryRef: call.sid, deliveredAt: new Date().toISOString() });
    const r = await getStore().getRequest(m.requestId);
    if (r) emit("request:updated", { request: r });
    return { ok: true, simulated: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[voice] call to ${m.toPhone} failed: ${error}`);
    mutate(messageId, { status: "failed", error });
    return { ok: false, simulated: false, error };
  }
}

// ── TwiML helpers ────────────────────────────────────────────────────────────────────────────────────────────
// Hand-built rather than using twilio.twiml.VoiceResponse: the <Say> voice/language pairing is the one thing that
// must be exactly right (a wrong voice id yields a silent call), and it is easier to see that it is right here.

export function esc(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function say(text: string, lang: LanguageCode): string {
  const l = languageOf(lang);
  return `<Say voice="${l.voice}" language="${l.sayLang}">${esc(text)}</Say>`;
}

export function voiceXml(...parts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}

/**
 * A speech turn. `speechTimeout="auto"` ends the turn when the speaker stops rather than after a fixed pause,
 * which is what makes this feel like talking to a person instead of an answering machine. Twilio caps a turn at
 * 60 s whatever we ask for, so prompts must say so.
 */
export function gatherSpeech(opts: { action: string; lang: LanguageCode; prompt: string }): string {
  const l = languageOf(opts.lang);
  return (
    `<Gather input="speech" language="${l.stt}" speechTimeout="auto" timeout="8" ` +
    `action="${esc(opts.action)}" method="POST" actionOnEmptyResult="true">` +
    say(opts.prompt, opts.lang) +
    `</Gather>`
  );
}

export { MAX_SPEECH_SECONDS };
