import { audit, getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";
import { peopleInZone } from "@/lib/zones";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const zone = (await getStore().listZones()).find((z) => z.id === id);
  if (!zone) return jsonError(404, "not_found");
  const people = await peopleInZone(zone);
  // Every look at people's locations is logged (who, when, which zone, how many).
  if (new URL(req.url).searchParams.get("quiet") !== "1") await audit(who, "viewed_people", `${zone.name}: ${people.length} people`);
  return json({ zone, people, generatedAt: new Date().toISOString() });
});
