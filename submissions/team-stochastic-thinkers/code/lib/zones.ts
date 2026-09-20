/** Who is (or recently was) inside a disaster zone. Merges shared user locations, helper positions and open requests. */
import { getStore } from "./store";
import { haversineKm } from "./dispatch";
import { mapsUrl } from "./sms";
import type { Skill, Zone } from "./types";

export const RECENT_WINDOW_MS = 6 * 3600_000; // "was in the area": any trail point from 6 h before the zone was declared

export type ZonePerson = {
  key: string; kind: "resident" | "helper" | "requester"; name: string | null; phone: string | null; skills: Skill[];
  lat: number; lng: number; accuracyM: number | null; source: string; updatedAt: string; ageMin: number;
  distanceKm: number; inZoneNow: boolean; lastInZoneAt: string | null; mapsUrl: string; note: string | null;
};

export async function peopleInZone(zone: Zone, now = new Date()): Promise<ZonePerson[]> {
  const store = getStore();
  const since = Date.parse(zone.createdAt) - RECENT_WINDOW_MS;
  const inside = (p: { lat: number; lng: number }) => haversineKm(zone.center, p) <= zone.radiusKm;
  const out = new Map<string, ZonePerson>();
  const age = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  const helpersByPhone = new Map((await store.listHelpers()).map((h) => [h.phone, h]));

  for (const l of await store.listLocations()) {
    const nowIn = inside(l.location);
    const hits = l.history.filter((p) => Date.parse(p.at) >= since && inside(p));
    if (!nowIn && hits.length === 0) continue;
    const h = helpersByPhone.get(l.phone);
    out.set(l.phone, {
      key: l.phone, kind: h ? "helper" : "resident", name: l.name ?? h?.name ?? null, phone: l.phone, skills: h?.skills ?? [],
      lat: l.location.lat, lng: l.location.lng, accuracyM: l.accuracyM, source: l.source, updatedAt: l.updatedAt, ageMin: age(l.updatedAt),
      distanceKm: +haversineKm(zone.center, l.location).toFixed(3), inZoneNow: nowIn,
      lastInZoneAt: nowIn ? l.updatedAt : hits[hits.length - 1]?.at ?? null, mapsUrl: mapsUrl(l.location), note: null,
    });
  }
  // Helpers who have not shared a separate location still report theirs while on duty.
  for (const h of helpersByPhone.values()) {
    if (out.has(h.phone) || !h.location || !inside(h.location)) continue;
    out.set(h.phone, {
      key: h.phone, kind: "helper", name: h.name, phone: h.phone, skills: h.skills, lat: h.location.lat, lng: h.location.lng,
      accuracyM: null, source: h.onDuty ? "on duty" : "last duty", updatedAt: h.lastSeen, ageMin: age(h.lastSeen),
      distanceKm: +haversineKm(zone.center, h.location).toFixed(3), inZoneNow: true, lastInZoneAt: h.lastSeen, mapsUrl: mapsUrl(h.location), note: null,
    });
  }
  // People who asked for help from inside the zone (may be anonymous app users).
  for (const r of await store.listOpenRequests()) {
    if (!r.location || !inside(r.location)) continue;
    const key = r.requesterPhone ?? `request:${r.id}`;
    const prev = out.get(key);
    const note = `${r.status.toUpperCase()} request: ${r.description.slice(0, 120)}`;
    if (prev) { prev.note = note; prev.kind = "requester"; continue; }
    out.set(key, {
      key, kind: "requester", name: r.requesterName, phone: r.requesterPhone, skills: [], lat: r.location.lat, lng: r.location.lng,
      accuracyM: null, source: r.locationSource, updatedAt: r.updatedAt, ageMin: age(r.updatedAt),
      distanceKm: +haversineKm(zone.center, r.location).toFixed(3), inZoneNow: true, lastInZoneAt: r.updatedAt, mapsUrl: mapsUrl(r.location), note,
    });
  }
  return [...out.values()].sort((a, b) => Number(b.kind === "requester") - Number(a.kind === "requester") || a.distanceKm - b.distanceKm);
}
