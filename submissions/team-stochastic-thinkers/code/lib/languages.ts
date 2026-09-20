/**
 * The languages Sahaya speaks, and the three different codes each one needs.
 *
 * A customer in Kollam types Malayalam; the electrician who takes the job may read only Tamil. Nothing else in the
 * product matters if those two cannot understand each other, so language is a first-class property of a person,
 * not a display setting.
 *
 * Each language carries four identifiers that are NOT interchangeable and are a classic source of silent failure:
 *   - `code`      our own storage key, and the BCP-47 tag the browser's SpeechRecognition wants (`lang`)
 *   - `stt`       the `language` attribute of TwiML <Gather input="speech"> (Google STT via Twilio)
 *   - `voice`     the `voice` attribute of TwiML <Say> — a literal Google voice id, wrong value = a silent call
 *   - `sayLang`   the `language` attribute of <Say>, which Twilio still wants alongside a Google voice
 *
 * Voice ids verified against twilio.com/docs/voice/twiml/say/text-speech (September 2026). None of the four South
 * Indian languages have an Amazon Polly voice, so every voice here is a Google one; do not "simplify" these to
 * Polly names.
 *
 * `endonym` is what the language calls itself. A picker that lists "Malayalam" to someone who reads only Malayalam
 * has already failed them, so the UI shows the endonym first and the English name second.
 */

export const LANGUAGES = [
  { code: "ml-IN", endonym: "മലയാളം",  english: "Malayalam", stt: "ml-IN", voice: "Google.ml-IN-Standard-A", sayLang: "ml-IN" },
  { code: "ta-IN", endonym: "தமிழ்",    english: "Tamil",     stt: "ta-IN", voice: "Google.ta-IN-Standard-A", sayLang: "ta-IN" },
  { code: "kn-IN", endonym: "ಕನ್ನಡ",    english: "Kannada",   stt: "kn-IN", voice: "Google.kn-IN-Standard-A", sayLang: "kn-IN" },
  { code: "te-IN", endonym: "తెలుగు",   english: "Telugu",    stt: "te-IN", voice: "Google.te-IN-Standard-A", sayLang: "te-IN" },
  { code: "hi-IN", endonym: "हिन्दी",    english: "Hindi",     stt: "hi-IN", voice: "Google.hi-IN-Standard-A", sayLang: "hi-IN" },
  { code: "en-IN", endonym: "English",  english: "English",   stt: "en-IN", voice: "Google.en-IN-Standard-A", sayLang: "en-IN" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];
export type Language = (typeof LANGUAGES)[number];

/** What someone gets if they never chose: Malayalam, because Sahaya is built for Kerala first. */
export const DEFAULT_LANGUAGE: LanguageCode = "ml-IN";

/** The language every fallback lands on. English has the best model coverage, so it is the safe relay pivot. */
export const FALLBACK_LANGUAGE: LanguageCode = "en-IN";

const BY_CODE = new Map<string, Language>(LANGUAGES.map((l) => [l.code, l]));

export function isLanguage(x: unknown): x is LanguageCode {
  return typeof x === "string" && BY_CODE.has(x);
}

/** Never throws: an unknown or missing code resolves to the default, so a bad record cannot break a call. */
export function languageOf(code: string | null | undefined): Language {
  return (code && BY_CODE.get(code)) || BY_CODE.get(DEFAULT_LANGUAGE)!;
}

/** "മലയാളം (Malayalam)" — endonym first. Collapses to one word for English, which would otherwise read twice. */
export function languageLabel(code: string | null | undefined): string {
  const l = languageOf(code);
  return l.endonym === l.english ? l.english : `${l.endonym} (${l.english})`;
}

/**
 * The IVR digit menu for callers we cannot identify. Ordered as LANGUAGES is, so "press 1" is always Malayalam.
 * Twilio <Gather input="dtmf" numDigits="1"> gives us a single character back, hence the 1..6 range.
 */
export const LANGUAGE_MENU = LANGUAGES.map((l, i) => ({ digit: String(i + 1), ...l }));

export function languageForDigit(digit: string | null | undefined): LanguageCode | null {
  const hit = LANGUAGE_MENU.find((l) => l.digit === String(digit ?? "").trim());
  return hit ? hit.code : null;
}

/**
 * Twilio's speech recogniser hard-stops at 60 seconds per <Gather>. Every prompt that asks someone to speak has to
 * be written with that ceiling in mind ("in one minute, what is the problem?"), and the relay splits nothing:
 * a message is one turn. Exported so the prompts and the UI hint stay in sync with the real limit.
 */
export const MAX_SPEECH_SECONDS = 60;
