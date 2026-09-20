import { getStore } from "@/lib/store";
import { HELPER_SESSION_MAX_AGE_SEC, SESSION_COOKIE, isSecureRequest, serializeCookie, sign } from "@/lib/session";
import { normalizePhone } from "@/lib/sms";
import { checkCode } from "@/lib/otp";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request) => {
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const phone = normalizePhone(body.value.phone);
  if (!phone) return jsonError(400, "phone_invalid");
  const code = body.value.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return jsonError(400, "code_invalid");
  const store = getStore();
  if (!(await checkCode(phone, code))) return jsonError(401, "invalid_code");
  const helper = await store.getHelperByPhone(phone);
  const token = sign({ phone, helperId: helper?.id ?? null, exp: Date.now() + HELPER_SESSION_MAX_AGE_SEC * 1000 });
  return json({ ok: true, helper, token }, 200, {
    "set-cookie": serializeCookie(SESSION_COOKIE, token, { maxAgeSec: HELPER_SESSION_MAX_AGE_SEC, secure: isSecureRequest(req) }),
  });
});
