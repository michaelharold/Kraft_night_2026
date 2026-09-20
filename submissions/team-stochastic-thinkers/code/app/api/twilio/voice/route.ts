/**
 * A phone call arrives at the Sahaya number. This is the front door for everyone with no app, no data, or no
 * literacy in the language the app happens to be in.
 *
 * Two kinds of caller reach here:
 *   - someone we know, by the number they are calling from. We already have their language, so we skip straight
 *     to "tell me what you need". One fewer menu for a person standing in a flooded kitchen.
 *   - a stranger. They get a six-option digit menu, each option spoken in its own language, because a menu read
 *     entirely in Malayalam is useless to the Tamil speaker it is meant to help.
 *
 * Callers with an open job are put into that conversation instead of starting a new one: a second call is almost
 * always "where are you?", not a new leak.
 */
import { categoryOf } from "@/lib/policy";
import { DEFAULT_LANGUAGE, LANGUAGE_MENU, languageOf } from "@/lib/languages";
import { getStore } from "@/lib/store";
import { gatherSpeech, say, voiceXml } from "@/lib/voice";
import { apology, callerPhone, readFields, xml } from "./_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice");
  if (!read.ok) return new Response("forbidden", { status: 403 });
  const phone = callerPhone(read.fields);

  try {
    const store = getStore();
    const known = phone ? await store.getHelperByPhone(phone) : null;

    // Someone we have met before: straight to the point, in their own language.
    if (known?.language) {
      const lang = languageOf(known.language).code;
      const open = (await store.listOpenRequests()).find(
        (r) => categoryOf(r) === "SERVICE" && (r.requesterHelperId === known.id || r.matchedHelperId === known.id)
          && r.status !== "resolved" && r.status !== "cancelled");
      const prompt = open
        ? `Hello ${known.name}. You have a job open. Say your message for the other person after the beep. You have one minute.`
        : `Hello ${known.name}. In one minute, tell Sahaya what help you need and where you are.`;
      return xml(voiceXml(gatherSpeech({
        action: `/api/twilio/voice/message?lang=${lang}${open ? `&r=${encodeURIComponent(open.id)}` : ""}`,
        lang, prompt,
      })));
    }

    // A stranger. Offer the menu, each line in the language it is offering.
    const lines = LANGUAGE_MENU.map((l) => say(`For ${l.english}, press ${l.digit}.`, l.code)).join("");
    return xml(voiceXml(
      `<Gather input="dtmf" numDigits="1" timeout="6" action="/api/twilio/voice/language" method="POST" actionOnEmptyResult="true">`,
      say("Welcome to Sahaya.", DEFAULT_LANGUAGE),
      lines,
      `</Gather>`,
      // No key pressed: carry on in the default language rather than hanging up on them.
      `<Redirect method="POST">/api/twilio/voice/language?fallback=1</Redirect>`,
    ));
  } catch (e) {
    console.error("[voice] incoming call failed:", e);
    return apology(DEFAULT_LANGUAGE);
  }
}
