import { audit, getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const PATCH = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const store = getStore();
  const zone = (await store.listZones()).find((z) => z.id === id);
  if (!zone) return jsonError(404, "not_found");
  const body = await readJson(req);
  if (!body.ok || typeof body.value.active !== "boolean") return jsonError(400, "active_invalid");
  const saved = await store.saveZone({ ...zone, active: body.value.active });
  await audit(who, body.value.active ? "zone_reopened" : "zone_closed", zone.name);
  return json({ zone: saved });
});
