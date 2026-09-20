import { randomUUID } from "node:crypto";
import { audit, getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { isLatLng, json, jsonError, readJson, safe, text } from "@/lib/validate";
import type { ZoneKind } from "@/lib/types";

export const dynamic = "force-dynamic";
const KINDS: ZoneKind[] = ["landslide", "flood", "fire", "building_collapse", "cyclone", "other"];

export const GET = safe(async (req: Request) => {
  if (!getOps(req)) return jsonError(401, "unauthenticated");
  return json({ zones: await getStore().listZones() });
});

export const POST = safe(async (req: Request) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  const name = text(b.name, 80);
  if (!name) return jsonError(400, "name_invalid");
  if (!KINDS.includes(b.kind as ZoneKind)) return jsonError(400, "kind_invalid");
  if (!isLatLng(b.center)) return jsonError(400, "center_invalid");
  if (!(typeof b.radiusKm === "number" && b.radiusKm >= 0.05 && b.radiusKm <= 50)) return jsonError(400, "radius_invalid");
  const zone = await getStore().saveZone({ id: randomUUID(), name, kind: b.kind as ZoneKind, center: b.center, radiusKm: b.radiusKm,
    createdAt: new Date().toISOString(), createdBy: who.user, active: true });
  await audit(who, "zone_created", `${zone.name} (${zone.kind}, ${zone.radiusKm} km at ${zone.center.lat.toFixed(5)},${zone.center.lng.toFixed(5)})`);
  return json({ zone }, 201);
});
