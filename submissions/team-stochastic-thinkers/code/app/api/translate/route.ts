/**
 * Translate a short piece of text the person just spoke or typed.
 *
 * Exists for one job today: someone taps the mic and describes their problem in Malayalam, and everything
 * downstream of that — the job-scoping model, the trade it picks, the tools it lists, what providers read in
 * their feed — works in English. So the Malayalam is turned into English here, once, at the point of capture,
 * and the rest of the app carries on exactly as it always has.
 *
 * Deliberately NOT a general-purpose translation service:
 *   - signed-in callers only, and rate-limited per person, because each call occupies a local model for a second
 *     or two and a loop in a component could starve the job-scoping path that people are actually waiting on;
 *   - a hard length cap, since this is one spoken sentence, not a document.
 *
 * The response always carries `source`, and the caller is expected to show the original alongside a translation
 * rather than replacing it silently. On this hardware the model is fluent but not reliable about WHICH appliance
 * someone meant — "AC not cooling" came back as "the heater is not working" in testing — so the person has to be
 * able to see and fix what was understood before it decides which tradesperson gets dispatched.
 */
import { getHelperSession } from "@/lib/auth";
import { isLanguage, type LanguageCode } from "@/lib/languages";
import { MAX_TRANSLATE_CHARS, translate } from "@/lib/translate";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** One person, a few translations a minute: enough for speaking, nowhere near enough to monopolise the model. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const g = globalThis as unknown as { __resq_tr_rate?: Map<string, number[]> };
const hits = (g.__resq_tr_rate ??= new Map<string, number[]>());

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

  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const text = typeof body.value.text === "string" ? body.value.text.trim() : "";
  if (!text) return jsonError(400, "text_required");
  if (text.length > MAX_TRANSLATE_CHARS) return jsonError(400, "text_too_long");
  if (!isLanguage(body.value.from)) return jsonError(400, "from_invalid");
  const to: LanguageCode = isLanguage(body.value.to) ? body.value.to : "en-IN";

  if (tooMany(s.helperId ?? s.phone)) return jsonError(429, "rate_limited");

  const t = await translate({ text, from: body.value.from, to });
  return json({ text: t.text, original: t.original, from: t.from, to: t.to, source: t.source, model: t.model, note: t.note });
});
