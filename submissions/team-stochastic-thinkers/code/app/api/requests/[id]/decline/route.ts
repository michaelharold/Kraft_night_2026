import { getHelperSession } from "@/lib/auth";
import { json, jsonError, safe } from "@/lib/validate";
import { decline } from "@/lib/waves";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  await decline(id, s.helperId);
  return json({ ok: true });
});
