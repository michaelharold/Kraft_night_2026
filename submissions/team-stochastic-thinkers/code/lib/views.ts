/** The only place wire views are assembled (GET routes, tick, SSE snapshots). */
import { getStore } from "./store";
import { getGuidance } from "./guidance";
import { getSeedCenter, haversineKm, waveWindowMs } from "./dispatch";
import { mapsUrl } from "./sms";
import { isVerified, rateFor, tierOf } from "./policy";
import type { HelperView, IncomingCard, OpsView, RequestView } from "./types";

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

export async function buildRequestView(requestId: string): Promise<RequestView | null> {
  const store = getStore();
  const request = await store.getRequest(requestId);
  if (!request) return null;
  const ds = await store.listDispatches(requestId);
  const dispatches = await Promise.all(ds.map(async (d) => {
    const h = await store.getHelper(d.helperId);
    return { id: d.id, wave: d.wave, status: d.status, distanceKm: d.distanceKm, pingedAt: d.pingedAt, helperSkills: h?.skills ?? [], helperTier: tierOf(h) };
  }));
  let matchedHelper: RequestView["matchedHelper"] = null;
  if (request.matchedHelperId) {
    const h = await store.getHelper(request.matchedHelperId);
    if (h) {
      const acc = ds.find((d) => d.status === "accepted");
      // Live distance when both positions are known (helper shares location while on duty), else the dispatch distance.
      const live = h.location && request.location ? haversineKm(h.location, request.location) : null;
      matchedHelper = { id: h.id, name: h.name, skills: h.skills, phone: h.phone, location: h.location, reliability: h.reliability, equipment: h.equipment ?? [], trustTier: tierOf(h), verified: isVerified(h), rate: rateFor(h, request.service), distanceKm: live ?? acc?.distanceKm ?? null };
    }
  }
  return {
    request, dispatches, matchedHelper,
    guidance: request.triage ? getGuidance(request.triage.type) : null,
    waveEndsAt: request.status === "searching" && request.waveStartedAt ? plus(request.waveStartedAt, waveWindowMs()) : null,
  };
}

export async function buildHelperView(helperId: string | null): Promise<HelperView> {
  if (!helperId) return { helper: null, pinged: [], active: null };
  const store = getStore();
  const helper = await store.getHelper(helperId);
  const pinged: IncomingCard[] = [];
  for (const d of await store.listPingedForHelper(helperId)) {
    const r = await store.getRequest(d.requestId);
    if (!r || r.status !== "searching") continue;
    pinged.push({
      dispatch: d,
      request: { id: r.id, description: r.description, triage: r.triage, status: r.status, createdAt: r.createdAt, wave: r.wave },
      expiresAt: plus(d.pingedAt, waveWindowMs()),
    });
  }
  pinged.sort((a, b) => b.dispatch.pingedAt.localeCompare(a.dispatch.pingedAt) || a.dispatch.id.localeCompare(b.dispatch.id));
  const mine = (await store.listOpenRequests()).find((r) => r.status === "matched" && r.matchedHelperId === helperId);
  return { helper, pinged, active: mine ? { request: mine, mapsUrl: mine.location ? mapsUrl(mine.location) : null } : null };
}

export async function buildOpsView(): Promise<OpsView> {
  const store = getStore();
  const requests = await store.listOpenRequests();
  const dispatches = (await Promise.all(requests.map((r) => store.listDispatches(r.id)))).flat();
  return { requests, helpers: await store.listHelpers(), dispatches, center: getSeedCenter(), generatedAt: new Date().toISOString() };
}
