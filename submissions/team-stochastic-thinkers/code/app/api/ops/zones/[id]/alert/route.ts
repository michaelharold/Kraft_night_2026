import { audit, getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { sendSms } from "@/lib/sms";
import { json, jsonError, readJson, safe, text } from "@/lib/validate";
import { peopleInZone } from "@/lib/zones";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const zone = (await getStore().listZones()).find((z) => z.id === id);
  if (!zone) return jsonError(404, "not_found");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const message = text(body.value.message, 140);
  if (!message) return jsonError(400, "message_invalid");
  const phones = [...new Set((await peopleInZone(zone)).map((p) => p.phone).filter((p): p is string => !!p))];
  const results = await Promise.all(phones.map((p) => sendSms(p, `RESQ ALERT (${zone.name}): ${message}`)));
  await audit(who, "zone_alert", `${zone.name}: "${message}" to ${phones.length} phones`);
  return json({ ok: true, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});
