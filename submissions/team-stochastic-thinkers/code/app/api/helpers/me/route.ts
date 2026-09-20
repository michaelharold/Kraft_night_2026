import { getHelperSession } from "@/lib/auth";
import { json, jsonError, safe } from "@/lib/validate";
import { buildHelperView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s) return jsonError(401, "unauthenticated");
  return json({ ...(await buildHelperView(s.helperId)), phone: s.phone });
});
