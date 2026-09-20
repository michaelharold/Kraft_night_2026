/**
 * Translation between the languages in lib/languages.ts, run locally through Ollama.
 *
 * This sits in the middle of a stranger's plumbing emergency, so it is built to be boring and honest:
 *
 *  - It NEVER silently substitutes its own words for someone's. When the model is unavailable, times out, or
 *    returns something that is not a translation, `translate()` hands back the ORIGINAL text with
 *    `source: "failed"` and the caller shows both the original and a plain "could not translate" note. A helper
 *    reading an untranslated Malayalam message and asking a neighbour is a far better outcome than a helper
 *    reading a confident, wrong English sentence about which pipe is leaking.
 *  - Small local models like to be helpful: they add "Sure! Here is the translation:", explain their choices, or
 *    answer the message instead of translating it. The JSON schema plus stripNoise() below exist entirely to
 *    catch that, and a result that still looks like commentary is discarded rather than shown.
 *  - Same-language pairs short-circuit without touching the model, which is the common case once two people in
 *    the same district are matched.
 *
 * Nothing leaves the machine: the same Ollama instance that scopes jobs does the translating.
 */
import { languageOf, type LanguageCode } from "./languages";
import { SarvamError, sarvamConfigured, toSarvamLang, translateText } from "./sarvam";

export class TranslateError extends Error {
  constructor(public code: "ai_unavailable" | "ai_invalid", message: string) { super(message); }
}

const ollamaUrl = () => (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
// Deliberately does NOT inherit OLLAMA_SCOPE_MODEL. Scoping and translating are different jobs with different
// size budgets, and inheriting it made translation default to llama3.1 — 4.9 GB, which times out on an 8 GB
// laptop. There is no default model here that is known to translate between two Indian languages; see the note
// at the top of this file. RESQ_TRANSLATE_MODEL is how you point it at one that can.
const primaryModel = () => process.env.RESQ_TRANSLATE_MODEL?.trim() || "gemma2:2b";
const fallbackModel = () => process.env.OLLAMA_MODEL?.trim() || "qwen2.5:3b";
// 60 s, not 30: measured, llama3.1 needs ~35 s for a short sentence on this laptop and was timing out into a
// fallback model that cannot translate at all. A translation that is late is survivable; a wrong one is not.
const timeoutMs = () => { const n = Number(process.env.RESQ_TRANSLATE_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 60_000; };

/** Longer than one <Gather> turn can produce (60 s of speech), with room for a typed note. */
export const MAX_TRANSLATE_CHARS = 2_000;

export type Translation = {
  text: string;              // the translated text, or the original when source is "passthrough" | "failed"
  original: string;
  from: LanguageCode;
  to: LanguageCode;
  source: "sarvam" | "ollama" | "passthrough" | "failed";
  model: string | null;
  note: string | null;       // why a translation is missing, shown to the reader verbatim
};

/**
 * Cache keyed on from|to|text. Two helpers matched to the same job are sent the same sentence, and a retry after a
 * dropped call re-translates the same recording, so this saves a 2–6 s model round trip on the path where someone
 * is waiting for a phone to ring. Bounded and process-local; translations are not secret but they are personal,
 * so nothing is written to disk.
 */
const g = globalThis as unknown as { __resq_translations?: Map<string, Translation> };
const cache = (g.__resq_translations ??= new Map());
const CACHE_MAX = 500;

function remember(key: string, value: Translation): Translation {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

/**
 * Malayalam -> English is the one pair this app leans on heavily (the mic, and anyone typing Manglish), so it
 * gets a prompt written for how people in Kerala actually write rather than a generic "translate X to Y".
 *
 * Two things in here were each worth several correct answers when measured against gemma2:2b:
 *
 *  1. MANGLISH. Half the input is Malayalam typed in Latin letters — "ente pipe leak avunu". Told only
 *     "translate from Malayalam", the model saw Latin text, assumed it was already English, and invented a
 *     plausible request instead: "almara vathil ilaki" (cupboard door loose) came back as "I need a plumber to
 *     fix the tap". Naming Manglish and glossing the common verbs took that set from 1/8 to 8/8.
 *  2. "Name the SAME object the user named." Small models drift to a more common noun — an AC became a heater,
 *     a cupboard became a window, a blocked toilet became a stuck door. Each of those dispatches the wrong
 *     trade, which is the most expensive mistake this app can make, so the rule is stated bluntly.
 */
function malayalamToEnglishPrompt(): string {
  return [
    "You are a translation engine for a neighbourhood home-services app in Kerala, India.",
    "The user is describing a household problem in Malayalam. It arrives one of two ways, and you handle both:",
    "  - Malayalam script, e.g. പൈപ്പ് ചോരുന്നു",
    "  - MANGLISH: Malayalam typed in English/Latin letters, often mixed with English words, e.g.",
    `    "ente pipe leak avunu" = "my pipe is leaking"; "pottipoyi" = "burst"; "varunnu" = "is coming";`,
    `    "cheyyunnilla" = "is not working"; "poyi" = "gone/out"; "adanju" = "blocked"; "ilaki" = "loose";`,
    `    "niranju" = "filled up"; "thanuppikkunnilla" = "not cooling"; "ittuveezhunnu" = "dripping";`,
    `    "almara" = "cupboard"; "vathil" = "door"; "vellam" = "water"; "current" = "electricity".`,
    "Rewrite the message as plain English a plumber, electrician or carpenter would understand.",
    `Return ONLY one raw JSON object: {"translation": "..."}. No prose, no markdown, no code fences, no notes.`,
    "Rules:",
    "- Translate the meaning, not word by word. Keep it short and plain.",
    "- Name the SAME object the user named. A cupboard is not a window; an AC is not a heater; a toilet is not a door.",
    "- Do NOT answer, advise on, or comment on the problem. Only translate.",
    "- Do NOT invent a trade, a room or a cause the user did not mention.",
    "- Keep every number, measurement, price, address and name exactly as written.",
    `- Keep household words concrete ("tap", "pipe", "fuse box", "drain", "AC", "fan", "cupboard").`,
    "- Malayalam words written in English letters must be converted, not copied.",
  ].join("\n");
}

function systemPrompt(from: LanguageCode, to: LanguageCode): string {
  if (from === "ml-IN" && to === "en-IN") return malayalamToEnglishPrompt();
  const f = languageOf(from), t = languageOf(to);
  return [
    `You are a translation engine for a neighbourhood home-services app in Kerala, India.`,
    `Translate the user's message from ${f.english} into ${t.english}.`,
    `Return ONLY one raw JSON object: {"translation": "..."}. No prose, no markdown, no code fences, no notes.`,
    `Rules:`,
    `- Translate the meaning, not word by word. Keep it short and plain, the way a neighbour would say it.`,
    `- Do NOT answer, advise on, or comment on the message. You are not helping with the problem, only translating.`,
    `- Keep every number, measurement, price, address and name exactly as written.`,
    `- Keep household and trade words concrete ("tap", "fuse box", "drain") rather than formal synonyms.`,
    `- If the message is already in ${t.english}, return it unchanged.`,
  ].join("\n");
}

const schema = () => ({
  type: "object",
  properties: { translation: { type: "string" } },
  required: ["translation"],
});

/**
 * Small models wrap their answer in pleasantries even when told not to. Strip the common shells; anything still
 * carrying a preamble is treated as a failed translation upstream rather than shown to a user.
 */
const PREAMBLES = [
  /^(sure|certainly|of course|okay|ok|got it)\b[\s!.,:;–—-]*/i,
  /^here(?:'s| is| are)?(?: the)?(?: translation)?\b[\s!.,:;–—-]*/i,
  /^(?:the\s+)?translation(?:\s+is)?\b[\s!.,:;–—-]*/i,
  /^in\s+\w+\b\s*[:,]\s*/i,            // "In Tamil: …"
];

function stripNoise(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Models stack their throat-clearing ("Sure! Here is the translation: …"), so peel until nothing more comes off.
  for (let pass = 0; pass < PREAMBLES.length + 1; pass++) {
    const before = out;
    for (const re of PREAMBLES) out = out.replace(re, "").trim();
    if (out === before) break;
  }
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) out = out.slice(1, -1).trim();
  return out;
}

/**
 * The script each language is written in. Two languages in DIFFERENT scripts give us a cheap, decisive check that
 * a translation actually happened: Tamil output that contains no Tamil letters is not Tamil.
 */
const SCRIPTS: Record<LanguageCode, RegExp> = {
  "ml-IN": /[\u0D00-\u0D7F]/g,   // Malayalam
  "ta-IN": /[\u0B80-\u0BFF]/g,   // Tamil
  "kn-IN": /[\u0C80-\u0CFF]/g,   // Kannada
  "te-IN": /[\u0C00-\u0C7F]/g,   // Telugu
  "hi-IN": /[\u0900-\u097F]/g,   // Devanagari
  "en-IN": /[A-Za-z]/g,            // Latin
};
const countIn = (text: string, re: RegExp) => (text.match(new RegExp(re.source, "g")) ?? []).length;

/**
 * Catches the failure that matters most and is otherwise invisible: a small model handed text it cannot translate
 * simply ECHOES IT BACK, occasionally altering a character. Nothing above notices — it is not commentary, it is
 * not empty, it is not too long — so the relay labels the original "தமிழ்" and reads Malayalam down the phone to a
 * Tamil speaker who cannot understand a word of it, with no hint that anything went wrong.
 *
 * Measured: qwen2.5:3b returned "പൈപ്പ് മാറ്റി…" verbatim for a ml-IN -> ta-IN request.
 *
 * Only decides when the two languages use different scripts; within one script it says nothing and the other
 * guards stand alone.
 */
function wrongScript(out: string, from: LanguageCode, to: LanguageCode): boolean {
  const target = SCRIPTS[to], source = SCRIPTS[from];
  if (!target || !source || target.source === source.source) return false;
  const inTarget = countIn(out, target);
  if (inTarget > 0) return countIn(out, source) > inTarget; // still mostly the language we started from
  // Nothing in the target script. Any letters at all then means it answered in some OTHER language — measured:
  // gemma2:2b replies to a Malayalam->Tamil request in English, which has neither Tamil nor Malayalam letters
  // and sailed through an earlier version of this check. A digits-only reply ("800") is legitimately scriptless.
  return /\p{L}/u.test(out);
}

/** True when the model explained itself instead of translating — we would rather show the original than this. */
function looksLikeCommentary(out: string, original: string): boolean {
  if (!out) return true;
  if (/\b(I (cannot|can't|am unable)|as an AI|note that|it (seems|appears) (that|like))\b/i.test(out)) return true;
  // A one-line message that comes back four times longer is an explanation, not a translation.
  return original.length > 20 && out.length > original.length * 4;
}

async function generate(model: string, text: string, from: LanguageCode, to: LanguageCode, ms: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, system: systemPrompt(from, to), prompt: text, stream: false, format: schema(),
        keep_alive: "10m", options: { temperature: 0, num_predict: 900 },
      }),
    });
    if (res.status === 404) throw new TranslateError("ai_unavailable", `model ${model} is not installed`);
    if (!res.ok) throw new TranslateError("ai_unavailable", `ollama responded ${res.status}`);
    const body = (await res.json()) as { response?: string };
    if (typeof body.response !== "string") throw new TranslateError("ai_invalid", "no response field");
    let parsed: unknown;
    try { parsed = JSON.parse(body.response); } catch { throw new TranslateError("ai_invalid", "model did not return JSON"); }
    const raw = (parsed as { translation?: unknown })?.translation;
    if (typeof raw !== "string") throw new TranslateError("ai_invalid", "no translation field");
    const cleaned = stripNoise(raw);
    if (!cleaned) throw new TranslateError("ai_invalid", "empty translation");
    if (looksLikeCommentary(cleaned, text)) throw new TranslateError("ai_invalid", "model commented instead of translating");
    if (wrongScript(cleaned, from, to)) throw new TranslateError("ai_invalid", `model returned ${languageOf(from).english} text for a ${languageOf(to).english} request`);
    return cleaned;
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new TranslateError("ai_unavailable", aborted ? `${model} timed out after ${ms} ms` : `cannot reach Ollama at ${ollamaUrl()}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate one message. NEVER throws and never loses the original: on any failure the caller gets the original
 * text back with source "failed" and a human-readable note to show beside it.
 */
export async function translate(input: { text: string; from: LanguageCode; to: LanguageCode }): Promise<Translation> {
  const original = (input.text ?? "").trim();
  const base = { original, from: input.from, to: input.to, model: null, note: null } as const;

  if (!original) return { ...base, text: "", source: "passthrough" };
  if (input.from === input.to) return { ...base, text: original, source: "passthrough" };
  if (original.length > MAX_TRANSLATE_CHARS) {
    return { ...base, text: original, source: "failed", note: `Message is longer than ${MAX_TRANSLATE_CHARS} characters and was not translated.` };
  }

  const key = `${input.from}|${input.to}|${original}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const started = Date.now();

  // Sarvam first, for every language pair. Measured against the local models this replaces: Malayalam -> Tamil
  // went from "llama3.1 times out at 240 s / qwen2.5:3b echoes the input" to correct Tamil in about half a
  // second, and English -> Malayalam from "keep the main switch off" becoming "do discord" to a correct sentence.
  // The guards below still run on its output: being a paid API is not a reason to stop checking.
  if (sarvamConfigured()) {
    const from = toSarvamLang(input.from), to = toSarvamLang(input.to);
    if (from && to) {
      try {
        const text = await translateText({ text: original, from, to });
        const cleaned = stripNoise(text);
        if (cleaned && !looksLikeCommentary(cleaned, original) && !wrongScript(cleaned, input.from, input.to)) {
          console.log(`[translate] ${input.from}->${input.to} sarvam chars=${original.length} ms=${Date.now() - started}`);
          return remember(key, { ...base, text: cleaned, source: "sarvam", model: "sarvam:mayura", note: null });
        }
        console.warn(`[translate] sarvam returned something that did not pass the guards; falling back to a local model`);
      } catch (e) {
        const msg = e instanceof SarvamError ? `${e.code}: ${e.message}` : String(e);
        console.warn(`[translate] sarvam failed (${msg}); falling back to a local model`);
      }
    }
  }

  for (const model of [primaryModel(), fallbackModel()]) {
    try {
      const text = await generate(model, original, input.from, input.to, timeoutMs());
      console.log(`[translate] ${input.from}->${input.to} model=${model} chars=${original.length} ms=${Date.now() - started}`);
      return remember(key, { ...base, text, source: "ollama", model, note: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[translate] ${model} failed: ${msg}`);
    }
  }
  // Both models are gone or broken. Show the original — an untranslated message a reader can puzzle out beats a
  // confident wrong one, and beats showing them nothing at all.
  return { ...base, text: original, source: "failed", note: "Could not translate right now — showing the original message." };
}

/** Translation available at all? Used to decide whether to offer the feature rather than to gate a message. */
export async function translationAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name ?? "");
    return names.some((n) => n.startsWith(primaryModel().split(":")[0]) || n.startsWith(fallbackModel().split(":")[0]));
  } catch {
    return false;
  }
}
