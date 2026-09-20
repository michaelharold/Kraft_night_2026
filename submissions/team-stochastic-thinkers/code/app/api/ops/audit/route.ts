import { getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  if (!getOps(req)) return jsonError(401, "unauthenticated");
  return json({ audit: (await getStore().listAudit()).slice(0, 100) });
});
