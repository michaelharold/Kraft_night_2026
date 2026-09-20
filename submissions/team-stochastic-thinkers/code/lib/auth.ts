import { createHash, timingSafeEqual } from "node:crypto";
import { OPS_COOKIE, SESSION_COOKIE, parseCookies, verify, type HelperSession, type OpsSession } from "./session";
import { isUid } from "./validate";

const g = globalThis as unknown as { __resq_warned_ops?: boolean };
const sha = (s: string) => createHash("sha256").update(s).digest();

export function getOpsPassword(): string {
  if (process.env.OPS_PASSWORD) return process.env.OPS_PASSWORD;
  if (!g.__resq_warned_ops) { g.__resq_warned_ops = true; console.warn('[auth] OPS_PASSWORD unset: using "resq-ops"'); }
  return "resq-ops";
}
export function checkOpsPassword(candidate: string): boolean {
  return timingSafeEqual(sha(candidate), sha(getOpsPassword()));
}
export function getRequesterId(req: Request): string | null {
  const uid = req.headers.get("x-resq-uid");
  return isUid(uid) ? uid : null;
}
/**
 * Helper identity. Browser windows share cookies, so the web app sends the token per window: header
 * `x-resq-session` (or `?s=` for EventSource). "none" means "this window is not signed in" and deliberately
 * ignores the cookie, so one browser can run a requester and several helpers side by side.
 */
export function getHelperSession(req: Request): HelperSession | null {
  const header = req.headers.get("x-resq-session") ?? new URL(req.url).searchParams.get("s");
  const t = header !== null ? (header === "none" ? "" : header) : parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  const s = t ? verify<HelperSession>(t) : null;
  return s && typeof s.phone === "string" ? s : null;
}
export function isOps(req: Request): boolean {
  const header = req.headers.get("x-ops-password");
  if (header && checkOpsPassword(header)) return true;
  const t = parseCookies(req.headers.get("cookie"))[OPS_COOKIE];
  const s = t ? verify<OpsSession>(t) : null;
  return !!s && s.ops === true;
}
