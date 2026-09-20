/**
 * The caller pressed a digit on the language menu (or pressed nothing, and we fell back).
 *
 * Their choice is remembered on their account when we know who they are, so they never see this menu twice. For
 * a number we do not recognise the choice rides along in the query string for the rest of the call — we are not
 * going to create an account for someone in the middle of asking for help.
 */
import { DEFAULT_LANGUAGE, languageForDigit, languageOf } from "@/lib/languages";
import { categoryOf } from "@/lib/policy";
import { getStore } from "@/lib/store";
import { gatherSpeech, voiceXml } from "@/lib/voice";
import { apology, callerPhone, readFields, xml } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice/language");
  if (!read.ok) return new Response("forbidden", { status: 403 });

  try {
    const lang = languageForDigit(read.fields.Digits) ?? DEFAULT_LANGUAGE;
    const phone = callerPhone(read.fields);
    const store = getStore();
    const known = phone ? await store.getHelperByPhone(phone) : null;

    // Remember it, so a returning caller is never asked again.
    if (known && known.language !== lang) {
      await store.upsertHelper({ ...known, language: lang });
    }

    const open = known
      ? (await store.listOpenRequests()).find(
          (r) => categoryOf(r) === "SERVICE" && (r.requesterHelperId === known.id || r.matchedHelperId === known.id)
            && r.status !== "resolved" && r.status !== "cancelled")
      : null;

    const prompt = open
      ? "You have a job open. Say your message for the other person after the beep. You have one minute."
      : "In one minute, tell Sahaya what help you need and where you are. Speak after the beep.";

    return xml(voiceXml(gatherSpeech({
      action: `/api/twilio/voice/message?lang=${languageOf(lang).code}${open ? `&r=${encodeURIComponent(open.id)}` : ""}`,
      lang, prompt,
    })));
  } catch (e) {
    console.error("[voice] language selection failed:", e);
    return apology(DEFAULT_LANGUAGE);
  }
}
