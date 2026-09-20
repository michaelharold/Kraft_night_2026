import { getHelperSession } from "@/lib/auth";
import { buildDashboard } from "@/lib/feed";
import { json, jsonError, safe } from "@/lib/validate";
import { tickDueRequests } from "@/lib/waves";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s) return jsonError(401, "unauthenticated");
  await tickDueRequests(); // any open dashboard keeps overdue waves moving
  return json(await buildDashboard(s.helperId, s.phone));
});
