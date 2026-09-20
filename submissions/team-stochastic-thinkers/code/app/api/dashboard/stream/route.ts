import { getHelperSession } from "@/lib/auth";
import { buildDashboard } from "@/lib/feed";
import { markOnline } from "@/lib/presence";
import { sseResponse } from "@/lib/sse";
import { jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Live dashboard: rebuilt on any request/dispatch change nearby (feed) and on this user's own updates. */
export const GET = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s) return jsonError(401, "unauthenticated");
  if (s.helperId) { const offline = markOnline(s.helperId); req.signal.addEventListener("abort", offline); }
  return sseResponse(req, () => buildDashboard(s.helperId, s.phone), {
    "request:updated": undefined, "dispatch:created": undefined, "dispatch:updated": undefined,
    "helper:updated": (p) => p.helper.id === s.helperId,
  }, 300);
});
