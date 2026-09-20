/**
 * An in-app call turn: one person taps to talk, the other hears it in their own language.
 *
 * The whole pipeline runs here, in one request, because every step needs the Sarvam key and none of it belongs
 * on a phone:
 *
 *   1. TRANSCRIBE the clip in the SPEAKER's language. Their exact words are what get stored — not a round trip
 *      through English — so the other side can always see what was actually said.
 *   2. TRANSLATE into the listener's language (lib/translate.ts, which prefers Sarvam and falls back to Ollama).
 *   3. SPEAK it back in the listener's language, so this is a call and not a chat: they hear a voice, which is
 *      the point for anyone who would struggle to read a translation on a small screen.
 *
 * Step 3 is best-effort. If text-to-speech fails the message is still delivered and readable — losing the audio
 * degrades a call to a message, which is survivable; losing the message is not.
 */
import { getHelperSession } from "@/lib/auth";
import { languageOf } from "@/lib/languages";
import { SarvamError, sarvamConfigured, speechToText, textToSpeech, toSarvamLang } from "@/lib/sarvam";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";
import { captureVoiceMessage, putSpokenAudio } from "@/lib/voice";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"];

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  if (!sarvamConfigured()) return jsonError(503, "speech_not_configured");
  const { id } = await params;

  const store = getStore();
  const r = await store.getRequest(id);
  if (!r) return jsonError(404, "not_found");
  const role = r.requesterHelperId === s.helperId ? "requester" : r.matchedHelperId === s.helperId ? "helper" : null;
  if (!role) return jsonError(404, "not_found"); // a stranger must not learn that this job exists

  let form: FormData;
  try { form = await req.formData(); } catch { return jsonError(400, "form_invalid"); }
  const file = form.get("audio");
  if (!(file instanceof File)) return jsonError(400, "audio_missing");
  if (file.size === 0 || file.size > MAX_BYTES) return jsonError(400, "audio_size_invalid");
  const base = file.type.split(";")[0].trim().toLowerCase();
  if (base && !TYPES.includes(base)) return jsonError(400, "audio_type_invalid");

  const me = await store.getHelper(s.helperId);
  const myLang = languageOf(me?.language).code;

  // 1. Their own words, in their own language.
  let heard: string;
  try {
    const sar = toSarvamLang(myLang) ?? "unknown";
    heard = (await speechToText(Buffer.from(await file.arrayBuffer()), sar, file.name || "turn.webm")).text;
  } catch (e) {
    const code = e instanceof SarvamError ? e.code : "unavailable";
    console.error("[call] transcription failed:", code);
    return jsonError(502, "transcribe_failed", { detail: code });
  }

  // 2. Translated for the listener and put on the thread.
  const captured = await captureVoiceMessage({
    requestId: id, fromRole: role, fromHelperId: s.helperId, fromPhone: me?.phone ?? null,
    sourceText: heard, sourceLang: myLang, channel: "app",
  });
  if (!captured.ok) return jsonError(captured.reason === "no_counterpart" ? 409 : 400, captured.reason);
  const msg = captured.message;

  // 3. Spoken aloud for them. Best effort: a call that arrives as text still arrives.
  let spoke = false;
  try {
    const target = toSarvamLang(msg.targetLang);
    if (target && msg.translatedText) {
      putSpokenAudio(msg.id, await textToSpeech(msg.translatedText, target));
      spoke = true;
    }
  } catch (e) {
    console.error("[call] text-to-speech failed:", e instanceof SarvamError ? e.code : e);
  }

  console.log(`[call] ${role} ${msg.sourceLang}->${msg.targetLang} "${heard.slice(0, 40)}" spoken=${spoke}`);
  return json({ message: { ...msg, hasSpokenAudio: spoke }, heard, spoken: spoke }, 201);
});
