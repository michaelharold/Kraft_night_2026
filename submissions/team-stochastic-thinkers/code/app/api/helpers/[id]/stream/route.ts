import { getHelperSession, isOps } from "@/lib/auth";
import { sseResponse } from "@/lib/sse";
import { jsonError, safe } from "@/lib/validate";
import { buildHelperView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const s = getHelperSession(req);
  if (!isOps(req) && s?.helperId !== id) return jsonError(s ? 403 : 401, s ? "forbidden" : "unauthenticated");
  return sseResponse(req, async () => ({ ...(await buildHelperView(id)), phone: s?.phone ?? null }), {
    "dispatch:created": (p) => p.dispatch.helperId === id,
    "dispatch:updated": (p) => p.dispatch.helperId === id,
    "request:updated": (p) => p.request.matchedHelperId === id,
    "helper:updated": (p) => p.helper.id === id,
  });
});
