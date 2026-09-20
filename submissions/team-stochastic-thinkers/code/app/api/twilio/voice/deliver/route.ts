/**
 * The recipient picked up. This is what they hear.
 *
 * The translation is read TWICE. A stranger's voice reading an unexpected sentence down a phone line is hard to
 * catch first time, and there is no scrollback on a phone call — repetition is the only affordance available.
 *
 * When the translation failed, we say so plainly and then read the original words anyway, in the original
 * language's voice. A Tamil speaker hearing a Malayalam sentence at least knows someone is asking for help and
 * can find a neighbour; hearing nothing tells them nothing.
 */
import { DEFAULT_LANGUAGE } from "@/lib/languages";
import { gatherSpeech, getVoiceMessage, say, voiceXml } from "@/lib/voice";
import { apology, readFields, xml } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice/deliver");
  if (!read.ok) return new Response("forbidden", { status: 403 });

  try {
    const id = new URL(req.url).searchParams.get("m") ?? "";
    const m = getVoiceMessage(id);
    if (!m) return xml(voiceXml(say("This message is no longer available.", DEFAULT_LANGUAGE), "<Hangup/>"));

    const who = m.fromRole === "requester" ? "the customer" : "your worker";
    const intro = say(`Sahaya has a message from ${who}.`, m.targetLang);

    const body = m.translationSource === "failed"
      ? [
          say("We could not translate this message, so here it is in their own words.", m.targetLang),
          say(m.sourceText, m.sourceLang),
          say(m.sourceText, m.sourceLang),
        ]
      : [say(m.translatedText, m.targetLang), say("Again.", m.targetLang), say(m.translatedText, m.targetLang)];

    return xml(voiceXml(
      intro,
      ...body,
      gatherSpeech({
        action: `/api/twilio/voice/reply?m=${encodeURIComponent(m.id)}`,
        lang: m.targetLang,
        prompt: "To reply, speak after the beep. You have one minute. Otherwise hang up.",
      }),
      say("No reply recorded. Goodbye.", m.targetLang),
      "<Hangup/>",
    ));
  } catch (e) {
    console.error("[voice] delivery leg failed:", e);
    return apology(DEFAULT_LANGUAGE);
  }
}
