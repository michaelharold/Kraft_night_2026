/** Public, privacy-safe coverage for the home screen: skills + distance + position rounded to ~100 m, no names/phones. */
import { getStore } from "@/lib/store";
import { getSeedCenter, haversineKm } from "@/lib/dispatch";
import { LANDMARKS } from "@/lib/landmarks";
import { json, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat")), lng = Number(q.get("lng"));
  const at = Number.isFinite(lat) && Number.isFinite(lng) && q.get("lat") && q.get("lng") ? { lat, lng } : getSeedCenter();
  const helpers = (await getStore().getOnDutyHelpers())
    .map((h) => ({ skills: h.skills, distanceKm: +haversineKm(at, h.location!).toFixed(2), at: { lat: +h.location!.lat.toFixed(3), lng: +h.location!.lng.toFixed(3) } }))
    .filter((h) => h.distanceKm <= 5)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const area = [...LANDMARKS].sort((a, b) => haversineKm(at, a.location) - haversineKm(at, b.location))[0];
  return json({ center: at, area: area && haversineKm(at, area.location) < 3 ? area.name : null, count: helpers.length, helpers: helpers.slice(0, 40) });
});
