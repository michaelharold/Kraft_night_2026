/** HMAC-signed cookie sessions with Node crypto (README §6 Identity). */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "resq_session";
export const OPS_COOKIE = "resq_ops";
export const HELPER_SESSION_MAX_AGE_SEC = 7 * 24 * 3600;
export const OPS_SESSION_MAX_AGE_SEC = 12 * 3600;
export type HelperSession = { phone: string; helperId: string | null; exp: number };
export type OpsSession = { ops: true; exp: number };

const g = globalThis as unknown as { __resq_secret?: string };
function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!g.__resq_secret) {
    g.__resq_secret = randomBytes(32).toString("hex");
    console.warn("[session] SESSION_SECRET unset: using a random per-process secret; sessions die on restart");
  }
  return g.__resq_secret;
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function sign(payload: object): string {
  const body = JSON.stringify(payload);
  return `${b64(body)}.${b64(mac(body))}`;
}
export function verify<T extends { exp: number }>(token: string): T | null {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  try {
    const body = Buffer.from(p, "base64url").toString("utf8");
    const got = Buffer.from(s, "base64url");
    const want = mac(body);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const v = JSON.parse(body) as T;
    return typeof v.exp === "number" && v.exp > Date.now() ? v : null;
  } catch {
    return null;
  }
}
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function serializeCookie(name: string, value: string, o: { maxAgeSec: number; secure: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${o.maxAgeSec}`];
  if (o.maxAgeSec === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}
export function isSecureRequest(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
}
