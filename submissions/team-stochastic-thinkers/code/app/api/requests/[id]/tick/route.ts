import { getStore } from "@/lib/store";
import { hasIdentity, requestAccess } from "@/lib/access";
import { json, jsonError, safe } from "@/lib/validate";
import { tick } from "@/lib/waves";
import { buildRequestView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const r = await getStore().getRequest(id);
  if (!r) return jsonError(404, "not_found");
  if (!requestAccess(req, r)) return jsonError(hasIdentity(req) ? 403 : 401, hasIdentity(req) ? "forbidden" : "unauthenticated");
  const { advanced } = await tick(id);
  return json({ ...(await buildRequestView(id)), advanced });
});
