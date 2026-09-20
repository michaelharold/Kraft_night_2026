import { getHelperSession, getRequesterId, isOps } from "./auth";
import type { HelpRequest } from "./types";

/** Who may read/tick a request: ops, the requester (uid), or the matched helper. */
export function requestAccess(req: Request, r: HelpRequest, uidOverride?: string | null): "ops" | "requester" | "helper" | null {
  if (isOps(req)) return "ops";
  const uid = uidOverride ?? getRequesterId(req);
  if (uid && uid === r.requesterId) return "requester";
  const s = getHelperSession(req);
  if (s?.helperId && s.helperId === r.requesterHelperId) return "requester"; // signed-in requester
  if (s?.helperId && s.helperId === r.matchedHelperId) return "helper";
  return null;
}
export function hasIdentity(req: Request): boolean {
  return !!(getRequesterId(req) || getHelperSession(req) || isOps(req));
}
