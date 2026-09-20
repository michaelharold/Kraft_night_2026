"use client";

/*
 * Identity is per browser WINDOW (sessionStorage), not per browser: one laptop can run a requester and several
 * helpers side by side for a demo. `?new=1` in the URL starts a fresh identity in that window.
 */
const ss = {
  get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const windowStore = ss;

if (typeof window !== "undefined") {
  const u = new URL(window.location.href);
  if (u.searchParams.get("new") === "1") {
    try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("resq_")) sessionStorage.removeItem(k); } catch { /* ignore */ }
    u.searchParams.delete("new");
    window.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
  }
}

export function getUid(): string {
  let id = ss.get("resq_uid");
  if (!id) {
    id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    ss.set("resq_uid", id);
  }
  return id;
}

export const getHelperToken = () => ss.get("resq_helper_token");
export const setHelperToken = (t: string | null) => ss.set("resq_helper_token", t);

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; data: Record<string, unknown> };

export async function api<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", "x-resq-session": getHelperToken() ?? "none", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, status: res.status, data: data as T } : { ok: false, status: res.status, error: String(data?.error ?? res.statusText), data };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network_error", data: {} };
  }
}

export type LatLng = { lat: number; lng: number };

export function getPosition(timeoutMs = 8000): Promise<LatLng | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function fmtDistance(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return "–";
  return km < 1 ? `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m` : `${(Math.round(km * 10) / 10).toFixed(1)} km`;
}

/** Rough ETA for a neighbour on a two-wheeler in town (~20 km/h) plus a minute to set off. */
export function etaMinutes(km: number | null | undefined): number {
  return km == null ? 0 : Math.max(1, Math.ceil(km * 3 + 1));
}

export function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

export const DEMO_RADIUS_KM = 25;
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088, r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** A random spot 200–900 m from `center`, stable per window (so each helper window stands somewhere different). */
export function demoSpot(center: LatLng, reroll = false): LatLng {
  const saved = ss.get("resq_demo_spot");
  if (saved && !reroll) { try { return JSON.parse(saved) as LatLng; } catch { /* fall through */ } }
  const km = 0.2 + Math.random() * 0.7, b = Math.random() * 2 * Math.PI;
  const p = { lat: +(center.lat + (km / 111.32) * Math.cos(b)).toFixed(6), lng: +(center.lng + (km / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(b)).toFixed(6) };
  ss.set("resq_demo_spot", JSON.stringify(p));
  return p;
}
/** Move `from` toward `to` by `stepKm` (for the demo's simulated travel). */
export function stepToward(from: LatLng, to: LatLng, stepKm: number): LatLng {
  const d = distanceKm(from, to);
  if (d <= stepKm) return to;
  const f = stepKm / d;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}
