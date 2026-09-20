/**
 * The recipient answered. Their reply runs back down the same pipe in the opposite direction — translated into
 * the first person's language and read out to them on a fresh call.
 *
 * The direction is derived from the message being replied to, never from who is calling: it is the only way to
 * be sure a reply reaches the other party and not back to the speaker.
 */
import { DEFAULT_LANGUAGE } from "@/lib/languages";
import { captureVoiceMessage, deliverByCall, gatherSpeech, getVoiceMessage, say, voiceXml } from "@/lib/voice";
import { apology, callerPhone, readFields, xml } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice/reply");
  if (!read.ok) return new Response("forbidden", { status: 403 });

  try {
    const id = new URL(req.url).searchParams.get("m") ?? "";
    const original = getVoiceMessage(id);
    if (!original) return xml(voiceXml(say("This conversation is closed.", DEFAULT_LANGUAGE), "<Hangup/>"));

    const lang = original.targetLang; // the replier's language is whoever this message was addressed to
    const spoken = (read.fields.SpeechResult ?? "").trim();
    if (!spoken) {
      return xml(voiceXml(gatherSpeech({
        action: `/api/twilio/voice/reply?m=${encodeURIComponent(id)}`,
        lang, prompt: "Sorry, I did not catch that. Please speak again after the beep.",
      })));
    }

    // Replying flips the roles: a reply to the requester comes from the helper, and vice versa.
    const captured = await captureVoiceMessage({
      requestId: original.requestId,
      fromRole: original.fromRole === "requester" ? "helper" : "requester",
      fromHelperId: original.toHelperId,
      fromPhone: callerPhone(read.fields) ?? original.toPhone,
      sourceText: spoken, sourceLang: lang, channel: "call",
    });

    if (!captured.ok) {
      return xml(voiceXml(say("That job is closed now, so your reply was not sent.", lang), "<Hangup/>"));
    }

    void deliverByCall(captured.message.id);
    return xml(voiceXml(say("Your reply is on its way. Goodbye.", lang), "<Hangup/>"));
  } catch (e) {
    console.error("[voice] reply leg failed:", e);
    return apology(DEFAULT_LANGUAGE);
  }
}
