import { getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const a = await getStore().getAuthority(who.user);
  return json({ user: who.user, name: a?.name ?? who.user, role: who.role });
});
