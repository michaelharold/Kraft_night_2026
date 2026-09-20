/**
 * One Twilio client, authenticated either with an API key (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET, recommended)
 * or with the account auth token (TWILIO_AUTH_TOKEN). Both need TWILIO_ACCOUNT_SID. Secrets live in .env.local only.
 */
import type { Twilio } from "twilio";

const env = (k: string) => process.env[k]?.trim() || "";
export const twilioAuthConfigured = (): boolean =>
  !!env("TWILIO_ACCOUNT_SID") && (!!env("TWILIO_AUTH_TOKEN") || (!!env("TWILIO_API_KEY_SID") && !!env("TWILIO_API_KEY_SECRET")));

const g = globalThis as unknown as { __resq_twilio?: Promise<Twilio> };
export function getTwilio(): Promise<Twilio> {
  g.__resq_twilio ??= (async () => {
    const twilio = (await import("twilio")).default;
    const account = env("TWILIO_ACCOUNT_SID");
    return env("TWILIO_API_KEY_SID") && env("TWILIO_API_KEY_SECRET")
      ? twilio(env("TWILIO_API_KEY_SID"), env("TWILIO_API_KEY_SECRET"), { accountSid: account })
      : twilio(account, env("TWILIO_AUTH_TOKEN"));
  })().catch((e) => { g.__resq_twilio = undefined; throw e; });
  return g.__resq_twilio;
}
