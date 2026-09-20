/**
 * Audio in, English out.
 *
 * The browser records a clip (lib/client/recorder.ts) and posts it here; Sarvam transcribes it AND translates it
 * to English in one call, detecting the spoken language itself. Everything downstream of the description box —
 * job scoping, which trade is chosen, what providers read — then works in English exactly as it always has.
 *
 * Why the audio comes to the server instead of the browser calling Sarvam directly: the API key would otherwise
 * have to be shipped to every phone that opens the app.
 *
 * The response carries the detected language so the screen can say "heard Malayalam" and let the person correct
 * the English before it decides which tradesperson gets dispatched.
 */
import { getHelperSession } from "@/lib/auth";
import { languageOf } from "@/lib/languages";
import { SarvamError, sarvamConfigured, speechToEnglish, speechToText, toSarvamLang, translateText } from "@/lib/sarvam";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** A minute of Opus is comfortably inside this; it exists to stop someone posting a film. */
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"];

/** A few clips a minute per person: enough to speak, not enough to run up someone else's bill. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const g = globalThis as unknown as { __resq_speech_rate?: Map<string, number[]> };
const hits = (g.__resq_speech_rate ??= new Map<string, number[]>());
function tooMany(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > MAX_PER_WINDOW;
}

export const POST = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s) return jsonError(401, "unauthenticated");
  if (!sarvamConfigured()) return jsonError(503, "speech_not_configured", { detail: "Voice input needs SARVAM_API_KEY." });
  if (tooMany(s.helperId ?? s.phone)) return jsonError(429, "rate_limited");

  let form: FormData;
  try { form = await req.formData(); } catch { return jsonError(400, "form_invalid"); }
  const file = form.get("audio");
  if (!(file instanceof File)) return jsonError(400, "audio_missing");
  if (file.size === 0 || file.size > MAX_BYTES) return jsonError(400, "audio_size_invalid");
  // Browsers append codec parameters ("audio/webm;codecs=opus"), so compare on the base type only.
  const base = file.type.split(";")[0].trim().toLowerCase();
  if (base && !TYPES.includes(base)) return jsonError(400, "audio_type_invalid", { detail: file.type });

  /**
   * Recognition is ANCHORED to the language the person chose, not left to auto-detect.
   *
   * Auto-detect is a guess made on a few seconds of audio in a noisy kitchen, and when it guesses wrong the
   * transcript is wrong in a way nobody downstream can spot. Someone who has set their language to Tamil has
   * already told us the answer, so we use it: transcribe in Tamil, then translate. Auto-detect stays as the
   * fallback for an account with no language set.
   */
  const bytes = Buffer.from(await file.arrayBuffer());
  const me = s.helperId ? await getStore().getHelper(s.helperId) : null;
  const chosen = me?.language ? toSarvamLang(languageOf(me.language).code) : null;

  try {
    if (chosen && chosen !== "en-IN") {
      const heard = await speechToText(bytes, chosen, file.name || "speech.webm");
      const english = await translateText({ text: heard.text, from: chosen, to: "en-IN" });
      console.log(`[speech] ${file.size} bytes ${chosen} -> "${english.slice(0, 60)}"`);
      return json({ text: english, detected: chosen, confidence: null, heard: heard.text });
    }
    const out = await speechToEnglish(bytes, file.name || "speech.webm");
    console.log(`[speech] ${file.size} bytes auto -> "${out.text.slice(0, 60)}" (heard ${out.detected ?? "?"})`);
    return json({ text: out.text, detected: out.detected, confidence: out.confidence, heard: null });
  } catch (e) {
    const code = e instanceof SarvamError ? e.code : "unavailable";
    console.error("[speech] failed:", code, e instanceof Error ? e.message : e);
    return jsonError(code === "not_configured" ? 503 : 502, "speech_failed", { detail: code });
  }
});
