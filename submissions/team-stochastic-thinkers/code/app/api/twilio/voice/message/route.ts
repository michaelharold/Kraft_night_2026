/**
 * The caller has spoken. Twilio hands us their words as text, already recognised in their own language.
 *
 * Two things can happen with those words:
 *
 *   - THEY HAVE AN OPEN JOB (?r=<requestId>). This is the relay: the message is translated into the other
 *     person's language and that person's phone rings. Then we offer the caller the chance to say something else,
 *     so a back-and-forth is just this endpoint looping.
 *
 *   - THEY DO NOT. The words become a new service request. We translate to English first, because the job-scoping
 *     model reasons far better in English than in Malayalam, and scoping is what decides which trade gets alerted.
 *     The customer never sees that English — it is an internal pivot, and their original words stay on the record.
 *
 * A caller whose number we do not know is turned away politely rather than silently having an account created for
 * them: an inbound call is not consent to be registered, and a phone number is trivially spoofed.
 *
 * Delivery is deliberately NOT awaited. Twilio is holding a live call open waiting for this XML, and placing an
 * outbound call takes seconds; the caller hears their confirmation immediately while the other phone starts ringing.
 */
import { DEFAULT_LANGUAGE, languageOf } from "@/lib/languages";
import { ScopeError, scopeTask } from "@/lib/scope";
import { getStore } from "@/lib/store";
import { SKILL_LABELS } from "@/lib/taxonomy";
import { translate } from "@/lib/translate";
import { captureVoiceMessage, deliverByCall, gatherSpeech, say, voiceXml } from "@/lib/voice";
import { createServiceRequest } from "@/lib/waves";
import { apology, callerPhone, langParam, readFields, xml } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice/message");
  if (!read.ok) return new Response("forbidden", { status: 403 });

  const lang = langParam(req);
  try {
    const spoken = (read.fields.SpeechResult ?? "").trim();
    const phone = callerPhone(read.fields);
    const requestId = new URL(req.url).searchParams.get("r");

    // Twilio sends an empty SpeechResult when it heard nothing at all.
    if (!spoken) {
      return xml(voiceXml(gatherSpeech({
        action: `/api/twilio/voice/message?lang=${lang}${requestId ? `&r=${encodeURIComponent(requestId)}` : ""}`,
        lang, prompt: "Sorry, I did not catch that. Please speak again after the beep.",
      })));
    }

    const store = getStore();
    const caller = phone ? await store.getHelperByPhone(phone) : null;
    if (!caller) {
      return xml(voiceXml(
        say("This number is not registered with Sahaya. Please sign up in the app first, then call back.", lang),
        "<Hangup/>",
      ));
    }

    // ── The relay: a turn in an existing conversation ─────────────────────────────────────────────────────────
    if (requestId) {
      const request = await store.getRequest(requestId);
      const fromRole = request?.matchedHelperId === caller.id ? "helper" : "requester";
      const captured = await captureVoiceMessage({
        requestId, fromRole, fromHelperId: caller.id, fromPhone: phone,
        sourceText: spoken, sourceLang: lang, channel: "call",
      });

      if (!captured.ok) {
        const why = captured.reason === "no_counterpart"
          ? "Nobody has accepted your job yet. We will call you the moment someone does."
          : "That job is closed now, so your message was not sent.";
        return xml(voiceXml(say(why, lang), "<Hangup/>"));
      }

      void deliverByCall(captured.message.id); // the other phone starts ringing while this caller is still on the line
      return xml(voiceXml(
        say("Your message is being delivered now. Say anything else after the beep, or hang up.", lang),
        gatherSpeech({ action: `/api/twilio/voice/message?lang=${lang}&r=${encodeURIComponent(requestId)}`, lang, prompt: "" }),
        say("Thank you. Sahaya will call you when there is a reply.", lang),
        "<Hangup/>",
      ));
    }

    // ── A new job, spoken down the phone ──────────────────────────────────────────────────────────────────────
    // English is a pivot for the scoping model only; the caller's own words are what get stored as the description.
    const english = await translate({ text: spoken, from: lang, to: "en-IN" });
    let service;
    try {
      service = (await scopeTask(english.text, null)).category;
    } catch (e) {
      if (!(e instanceof ScopeError)) throw e;
      return xml(voiceXml(
        say("Sahaya could not work out what kind of help you need. Please try again, or use the app.", lang),
        "<Hangup/>",
      ));
    }

    const request = await createServiceRequest({
      account: caller,
      service,
      description: spoken,            // their words, not the English pivot
      location: caller.location,      // the last position we have for them; a call carries no GPS
    });

    const label = SKILL_LABELS[service] ?? service;
    return xml(voiceXml(
      say(`Sahaya is looking for a ${label} near you. We will call you as soon as someone accepts.`, lang),
      gatherSpeech({
        action: `/api/twilio/voice/message?lang=${lang}&r=${encodeURIComponent(request.id)}`,
        lang, prompt: "If you want to add anything, say it now. Otherwise you can hang up.",
      }),
      "<Hangup/>",
    ));
  } catch (e) {
    console.error("[voice] message handling failed:", e);
    return apology(lang || DEFAULT_LANGUAGE);
  }
}
