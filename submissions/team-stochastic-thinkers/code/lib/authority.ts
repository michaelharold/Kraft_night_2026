/**
 * Authority (coordinator) accounts: username + scrypt-hashed password, roles admin/officer, stored locally.
 * The first admin comes from OPS_USER / OPS_PASSWORD (defaults: coordinator / resq-ops).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getStore } from "./store";
import { OPS_COOKIE, parseCookies, verify } from "./session";
import { checkOpsPassword } from "./auth";
import type { Authority, AuthorityRole } from "./types";

export type OpsSession = { ops: true; user: string; role: AuthorityRole; exp: number };
export type OpsIdentity = { user: string; role: AuthorityRole };

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(pw, Buffer.from(salt, "hex"), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function ensureDefaultAuthority(): Promise<void> {
  const store = getStore();
  const user = (process.env.OPS_USER || "coordinator").trim().toLowerCase();
  if (await store.getAuthority(user)) return;
  await store.upsertAuthority({ username: user, name: "District coordinator", role: "admin",
    passwordHash: hashPassword(process.env.OPS_PASSWORD || "resq-ops"), createdAt: new Date().toISOString() });
}

export async function authenticate(username: string, password: string): Promise<Authority | null> {
  await ensureDefaultAuthority();
  const a = await getStore().getAuthority(username.trim().toLowerCase());
  return a && checkPassword(password, a.passwordHash) ? a : null;
}

/** Who is calling: an authority session cookie, or the x-ops-password header (scripts/tests act as admin "api"). */
export function getOps(req: Request): OpsIdentity | null {
  const header = req.headers.get("x-ops-password");
  if (header && checkOpsPassword(header)) return { user: "api", role: "admin" };
  const t = parseCookies(req.headers.get("cookie"))[OPS_COOKIE];
  const s = t ? verify<OpsSession>(t) : null;
  return s && s.ops === true ? { user: typeof s.user === "string" ? s.user : "coordinator", role: s.role === "officer" ? "officer" : "admin" } : null;
}

export async function audit(who: OpsIdentity, action: string, detail: string): Promise<void> {
  await getStore().audit({ at: new Date().toISOString(), user: who.user, action, detail });
}
