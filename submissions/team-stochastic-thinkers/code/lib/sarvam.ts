/**
 * Sarvam AI — speech and translation for Indian languages.
 *
 * This is the one piece of Sahaya that is not local, and it earns that exception. Measured on this laptop:
 *
 *   task                     local model                          Sarvam
 *   ----------------------   ----------------------------------   --------------------------------
 *   Malayalam -> Tamil       llama3.1 timed out at 240 s;         correct Tamil, ~0.5 s
 *                            qwen2.5:3b echoed the input back
 *   English -> Malayalam     gemma2:2b turned "keep the main      correct Malayalam, ~0.5 s
 *                            switch off" into "do discord"
 *   Malayalam speech -> text Chrome's ml-IN recogniser hangs      exact transcript, ~0.8 s
 *
 * Nothing else in the app changed its mind about running locally: job scoping and receipt reading still use
 * Ollama. Only the language layer goes out, because an 8 GB laptop cannot hold a model that does Indic
 * translation, and a mistranslated address or a wrongly named appliance is a person sent to the wrong house.
 *
 * Every function here fails soft. The caller is expected to carry on without a translation rather than block
 * someone from asking for help because a third party is down.
 */

const BASE = "https://api.sarvam.ai";

export class SarvamError extends Error {
  constructor(public code: "not_configured" | "unavailable" | "invalid", message: string) { super(message); }
}

export const sarvamConfigured = (): boolean => !!process.env.SARVAM_API_KEY?.trim();
const key = () => process.env.SARVAM_API_KEY?.trim() ?? "";
const timeoutMs = () => { const n = Number(process.env.SARVAM_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 20_000; };

/** Sarvam speaks BCP-47 like the rest of the app, with one spelling difference: Odia is "od-IN", not "or-IN". */
export type SarvamLang =
  | "hi-IN" | "bn-IN" | "kn-IN" | "ml-IN" | "mr-IN" | "od-IN" | "pa-IN" | "ta-IN"
  | "te-IN" | "en-IN" | "gu-IN" | "as-IN" | "ur-IN";

async function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<unknown> {
  if (!sarvamConfigured()) throw new SarvamError("not_configured", "SARVAM_API_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "api-subscription-key": key(), ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    throw new SarvamError("unavailable", e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  if (!res.ok) {
    // The key itself is never logged, but the request id is: it is what Sarvam support asks for.
    console.error(`[sarvam] ${path} -> ${res.status} ${text.slice(0, 200)}`);
    throw new SarvamError(res.status === 401 || res.status === 403 ? "not_configured" : "unavailable", `sarvam ${res.status}`);
  }
  try { return JSON.parse(text); } catch { throw new SarvamError("invalid", "sarvam did not return JSON"); }
}

/**
 * Audio in, ENGLISH out, in one call. Sarvam detects the spoken language itself, so a customer does not have to
 * declare what they are about to speak — which matters, because the people most helped by this are the least
 * likely to go hunting in a settings menu first.
 *
 * Returns the English text plus the language it heard, so the UI can say "we heard Malayalam" honestly.
 */
export async function speechToEnglish(audio: Blob | Buffer, fileName = "speech.webm"): Promise<{
  text: string; detected: string | null; confidence: number | null;
}> {
  const form = new FormData();
  const blob = audio instanceof Blob ? audio : new Blob([new Uint8Array(audio)]);
  form.append("file", blob, fileName);
  const raw = (await post("/speech-to-text-translate", form)) as {
    transcript?: unknown; language_code?: unknown; language_probability?: unknown;
  };
  const text = typeof raw.transcript === "string" ? raw.transcript.trim() : "";
  if (!text) throw new SarvamError("invalid", "no transcript in response");
  return {
    text,
    detected: typeof raw.language_code === "string" ? raw.language_code : null,
    confidence: typeof raw.language_probability === "number" ? raw.language_probability : null,
  };
}

/** Audio in, a transcript in the SAME language out. Used when the speaker's own words are what matter. */
export async function speechToText(audio: Blob | Buffer, language: SarvamLang | "unknown" = "unknown", fileName = "speech.webm"): Promise<{
  text: string; detected: string | null;
}> {
  const form = new FormData();
  const blob = audio instanceof Blob ? audio : new Blob([new Uint8Array(audio)]);
  form.append("file", blob, fileName);
  form.append("language_code", language);
  const raw = (await post("/speech-to-text", form)) as { transcript?: unknown; language_code?: unknown };
  const text = typeof raw.transcript === "string" ? raw.transcript.trim() : "";
  if (!text) throw new SarvamError("invalid", "no transcript in response");
  return { text, detected: typeof raw.language_code === "string" ? raw.language_code : null };
}

/** Text translation (Sarvam's Mayura). Handles Manglish as a Malayalam source, which is the common case here. */
export async function translateText(input: { text: string; from: SarvamLang; to: SarvamLang }): Promise<string> {
  const raw = (await post("/translate", JSON.stringify({
    input: input.text, source_language_code: input.from, target_language_code: input.to,
  }), { "Content-Type": "application/json" })) as { translated_text?: unknown };
  const out = typeof raw.translated_text === "string" ? raw.translated_text.trim() : "";
  if (!out) throw new SarvamError("invalid", "no translated_text in response");
  return out;
}

/** Our language codes map to Sarvam's one-for-one today; this exists so Odia's od-IN/or-IN split has a home. */
export function toSarvamLang(code: string): SarvamLang | null {
  const fixed = code === "or-IN" ? "od-IN" : code;
  const known: SarvamLang[] = ["hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "en-IN", "gu-IN", "as-IN", "ur-IN"];
  return (known as string[]).includes(fixed) ? (fixed as SarvamLang) : null;
}

/**
 * Text in, spoken audio out, in the language given. This is the half that makes an in-app call feel like a call:
 * the person on the other end HEARS the message in their own language instead of reading a translation.
 *
 * Returns WAV bytes. Sarvam splits long input across several clips, so they are concatenated in order — for the
 * one-turn messages this app sends there is almost always just one.
 */
export async function textToSpeech(text: string, language: SarvamLang): Promise<Buffer> {
  const raw = (await post("/text-to-speech", JSON.stringify({
    text, target_language_code: language,
  }), { "Content-Type": "application/json" })) as { audios?: unknown };
  const parts = Array.isArray(raw.audios) ? raw.audios.filter((a): a is string => typeof a === "string") : [];
  if (!parts.length) throw new SarvamError("invalid", "no audio in response");
  return Buffer.concat(parts.map((b64) => Buffer.from(b64, "base64")));
}
