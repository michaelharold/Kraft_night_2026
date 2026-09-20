import { audit, ensureDefaultAuthority, getOps, hashPassword } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe, text } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  await ensureDefaultAuthority();
  const list = (await getStore().listAuthorities()).map(({ passwordHash: _h, ...a }) => a);
  return json({ authorities: list });
});

export const POST = safe(async (req: Request) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  if (who.role !== "admin") return jsonError(403, "forbidden");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  const username = typeof b.username === "string" && /^[a-z0-9._-]{3,32}$/.test(b.username.trim().toLowerCase()) ? b.username.trim().toLowerCase() : null;
  if (!username) return jsonError(400, "username_invalid");
  const name = text(b.name, 60);
  if (!name) return jsonError(400, "name_invalid");
  if (typeof b.password !== "string" || b.password.length < 8) return jsonError(400, "password_too_short");
  const role = b.role === "admin" ? "admin" : "officer";
  const store = getStore();
  if (await store.getAuthority(username)) return jsonError(409, "username_taken");
  await store.upsertAuthority({ username, name, role, passwordHash: hashPassword(b.password), createdAt: new Date().toISOString() });
  await audit(who, "authority_created", `${username} (${role})`);
  return json({ ok: true, username, name, role }, 201);
});
