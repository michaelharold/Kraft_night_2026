import { authenticate } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { OPS_COOKIE, OPS_SESSION_MAX_AGE_SEC, isSecureRequest, serializeCookie, sign } from "@/lib/session";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request) => {
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const { username, password } = body.value;
  if (typeof password !== "string" || !password) return jsonError(400, "password_invalid");
  const user = typeof username === "string" && username.trim() ? username : process.env.OPS_USER || "coordinator";
  const a = await authenticate(user, password);
  if (!a) return jsonError(401, "invalid_credentials");
  await getStore().audit({ at: new Date().toISOString(), user: a.username, action: "login", detail: "signed in" });
  const token = sign({ ops: true, user: a.username, role: a.role, exp: Date.now() + OPS_SESSION_MAX_AGE_SEC * 1000 });
  return json({ ok: true, user: a.username, name: a.name, role: a.role }, 200, {
    "set-cookie": serializeCookie(OPS_COOKIE, token, { maxAgeSec: OPS_SESSION_MAX_AGE_SEC, secure: isSecureRequest(req) }),
  });
});

export async function DELETE(req: Request) {
  return json({ ok: true }, 200, { "set-cookie": serializeCookie(OPS_COOKIE, "", { maxAgeSec: 0, secure: isSecureRequest(req) }) });
}
