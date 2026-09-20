import { getStore } from "@/lib/store";
import { requestAccess } from "@/lib/access";
import { sseResponse } from "@/lib/sse";
import { isUid, jsonError, safe } from "@/lib/validate";
import { buildRequestView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const r = await getStore().getRequest(id);
  if (!r) return jsonError(404, "not_found");
  const uid = new URL(req.url).searchParams.get("uid");
  if (!requestAccess(req, r, isUid(uid) ? uid : null)) return jsonError(403, "forbidden");
  return sseResponse(req, () => buildRequestView(id), {
    "request:updated": (p) => p.request.id === id,
    "dispatch:created": (p) => p.request.id === id,
    "dispatch:updated": (p) => p.request.id === id,
    "helper:updated": () => true, // matched helper may change after connect; view rebuild is cheap
  });
});
