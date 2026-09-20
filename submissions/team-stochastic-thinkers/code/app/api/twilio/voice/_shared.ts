/**
 * Shared plumbing for the five voice webhooks. Twilio POSTs form-encoded bodies and expects TwiML back within a
 * few seconds, so every handler here reads fields the same way, answers XML even on failure (a 500 makes Twilio
 * hang up on a caller mid-emergency), and validates the signature the same way the SMS webhook does.
 */
import { isOps } from "@/lib/auth";
import { normalizePhone } from "@/lib/sms";
import { DEFAULT_LANGUAGE, isLanguage, type LanguageCode } from "@/lib/languages";
import { say, voiceXml } from "@/lib/voice";

export const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });

export type TwilioFields = Record<string, string>;

export async function readFields(req: Request, path: string): Promise<{ ok: true; fields: TwilioFields } | { ok: false }> {
  const raw = await req.text();
  const fields = Object.fromEntries(new URLSearchParams(raw)) as TwilioFields;
  if (process.env.TWILIO_VALIDATE_SIGNATURE === "1" && !isOps(req)) {
    const twilio = (await import("twilio")).default;
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN ?? "", req.headers.get("x-twilio-signature") ?? "",
      `${process.env.PUBLIC_BASE_URL ?? ""}${path}`, fields);
    if (!valid) return { ok: false };
  }
  return { ok: true, fields };
}

export const callerPhone = (f: TwilioFields) => normalizePhone(f.From ?? "") || null;

/** ?lang= on our own callback URLs. Never trust it blindly — an unknown value falls back rather than throwing. */
export function langParam(req: Request, fallback: LanguageCode = DEFAULT_LANGUAGE): LanguageCode {
  const v = new URL(req.url).searchParams.get("lang");
  return isLanguage(v) ? v : fallback;
}

/** What a caller hears when something on our side broke. Said in their language when we know it. */
export const apology = (lang: LanguageCode) =>
  xml(voiceXml(say("Sorry, Sahaya could not take your message right now. Please try again in a minute.", lang), "<Hangup/>"));
