"use client";
import { useEffect, useState } from "react";
import { DEMO_RADIUS_KM, api, demoSpot, distanceKm, getHelperToken, windowStore, type LatLng } from "./api";

export const BEACON_MS = 30_000;

/**
 * While signed in, share this person's location every 30 s so verified authorities can find them inside a
 * disaster zone. GPS when it is plausibly at the venue, else this window's demo spot. Pausable (per window).
 */
export function useLocationBeacon(enabled: boolean, seedCenter: LatLng | null) {
  const [paused, setPausedState] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [source, setSource] = useState<"gps" | "demo" | null>(null);
  const [, force] = useState(0);

  useEffect(() => { setPausedState(windowStore.get("resq_share_loc") === "off"); }, []);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 5000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!enabled || paused || !seedCenter || !getHelperToken()) return;
    let stop = false;
    const send = async () => {
      const fix = await new Promise<{ at: LatLng; acc: number } | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ at: { lat: p.coords.latitude, lng: p.coords.longitude }, acc: p.coords.accuracy }),
          () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 20_000 });
      });
      const gps = fix && distanceKm(fix.at, seedCenter) <= DEMO_RADIUS_KM ? fix : null;
      const body = gps ? { location: gps.at, accuracyM: Math.round(gps.acc), source: "gps" } : { location: demoSpot(seedCenter), accuracyM: null, source: "demo" };
      const r = await api("/api/me/location", { body });
      if (!stop && r.ok) { setLastAt(Date.now()); setSource(gps ? "gps" : "demo"); }
    };
    void send();
    const t = setInterval(send, BEACON_MS);
    return () => { stop = true; clearInterval(t); };
  }, [enabled, paused, seedCenter]);

  const setPaused = async (p: boolean) => {
    setPausedState(p);
    windowStore.set("resq_share_loc", p ? "off" : null);
    if (p) await api("/api/me/location", { method: "DELETE" });
  };
  const ago = lastAt ? Math.round((Date.now() - lastAt) / 1000) : null;
  return { paused, setPaused, ago, source };
}
