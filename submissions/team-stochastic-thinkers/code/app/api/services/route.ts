/**
 * What is available near a point: per service, how many providers (and how many verified) are within 10 km and
 * the price range they charge. With ?service=plumber also the provider list (no phone numbers before a match).
 */
import { getStore } from "@/lib/store";
import { getSeedCenter, haversineKm } from "@/lib/dispatch";
import { isVerified, rateFor } from "@/lib/policy";
import { SERVICES, isService } from "@/lib/taxonomy";
import { json, jsonError, safe } from "@/lib/validate";
import { SERVICE_RADIUS_KM } from "@/lib/waves";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat")), lng = Number(q.get("lng"));
  const at = q.get("lat") && q.get("lng") && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : getSeedCenter();
  const service = q.get("service");
  if (service !== null && !isService(service)) return jsonError(400, "service_invalid");
  const near = (await getStore().getOnDutyHelpers())
    .map((h) => ({ h, km: haversineKm(at, h.location!) }))
    .filter((x) => x.km <= SERVICE_RADIUS_KM);
  const summary = SERVICES.map((s) => {
    const ps = near.filter((x) => x.h.skills.includes(s));
    const rates = ps.map((x) => rateFor(x.h, s)).filter((r): r is { min: number; max: number } => !!r);
    return { service: s, count: ps.length, verified: ps.filter((x) => isVerified(x.h)).length,
      minRate: rates.length ? Math.min(...rates.map((r) => r.min)) : null, maxRate: rates.length ? Math.max(...rates.map((r) => r.max)) : null,
      nearestKm: ps.length ? +Math.min(...ps.map((x) => x.km)).toFixed(2) : null };
  });
  const providers = service === null ? undefined : near
    .filter((x) => x.h.skills.includes(service))
    .sort((a, b) => Number(isVerified(b.h)) - Number(isVerified(a.h)) || a.km - b.km)
    .slice(0, 20)
    .map(({ h, km }) => ({ id: h.id, name: h.name, verified: isVerified(h), rating: +(h.reliability * 5).toFixed(1), rate: rateFor(h, service), distanceKm: +km.toFixed(2) }));
  return json({ center: at, radiusKm: SERVICE_RADIUS_KM, services: summary, ...(providers ? { providers } : {}) });
});
