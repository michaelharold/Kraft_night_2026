/**
 * The signed-in person picks the language they read, speak and want to be phoned in.
 *
 * Separate from the profile save in /api/helpers on purpose: language is changed from a picker in the header, at
 * any moment, including by someone who has not finished onboarding and therefore has no profile to save yet.
 * It is also the one setting where a failed write is immediately obvious to the user, so it answers with the
 * stored value rather than assuming.
 */
import { getHelperSession } from "@/lib/auth";
import { LANGUAGES, isLanguage, languageOf } from "@/lib/languages";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const s = getHelperSession(req);
  const me = s?.helperId ? await getStore().getHelper(s.helperId) : null;
  return json({ language: languageOf(me?.language).code, languages: LANGUAGES });
});

export const PUT = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  if (!isLanguage(body.value.language)) return jsonError(400, "language_invalid");

  const store = getStore();
  const me = await store.getHelper(s.helperId);
  if (!me) return jsonError(404, "not_found");
  const saved = await store.upsertHelper({ ...me, language: body.value.language });
  return json({ language: languageOf(saved.language).code });
});
