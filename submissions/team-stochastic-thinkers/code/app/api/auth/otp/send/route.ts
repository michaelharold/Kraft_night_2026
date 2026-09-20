import { normalizePhone } from "@/lib/sms";
import { OTP_TTL_SEC, sendCode } from "@/lib/otp";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";
const g = globalThis as unknown as { __resq_otp_rate?: Map<string, number> };

/** Texts a 6-digit sign-in code to the phone. The code is only ever returned in the response in on-screen demo mode. */
export const POST = safe(async (req: Request) => {
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const phone = normalizePhone(body.value.phone);
  if (!phone) return jsonError(400, "phone_invalid");
  const rate = (g.__resq_otp_rate ??= new Map());
  const last = rate.get(phone) ?? 0;
  if (Date.now() - last < 30_000) return jsonError(429, "too_many_requests", { retryAfterSec: Math.ceil((30_000 - (Date.now() - last)) / 1000) });
  const r = await sendCode(phone);
  if (!r.ok) {
    if (r.error === "sms_not_configured") return jsonError(503, "sms_not_configured", { detail: "SMS sign-in is not set up on this server." });
    return jsonError(502, "sms_failed", { detail: r.detail ?? "unknown" });
  }
  rate.set(phone, Date.now()); // only rate-limit codes that actually went out
  return json({ ok: true, phone, channel: r.channel, expiresInSec: OTP_TTL_SEC, ...(r.devCode ? { devCode: r.devCode } : {}), ...(r.devReason ? { devReason: r.devReason } : {}) });
});
