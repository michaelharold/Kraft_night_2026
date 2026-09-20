/**
 * The dispatch state machine (README §5, docs/CONTRACTS.md §4). This is the ONLY module that changes a request's
 * status/wave, a dispatch's status, or calls store.acceptDispatch. Transitions on one request are serialised by an
 * in-process lock, re-read state inside it, persist all writes, and only then emit events. No timers: waves advance
 * when somebody calls tick() (requester screen, ops screen), so it is idempotent.
 */
import { randomUUID } from "node:crypto";
import { emit } from "./events";
import { NO_HAZARD } from "./hazards";
import { getStore } from "./store";
import { MAX_WAVES, TICK_GRACE_MS, WAVE_RADII_KM, haversineKm, selectWave, waveWindowMs } from "./dispatch";
import { formatDistance, mapsUrl, sendSms, tplJobTaken, tplPing, tplRequesterEscalated, tplRequesterMatched, tplRequestClosed, tplServiceRequest } from "./sms";
import { alertPing, alertService, deliverAlertCall } from "./voice";
import { triage } from "./triage";
import { inferRole } from "./role";
import { releaseEscrowLocked, withHelperLock, type EscrowRelease } from "./escrow";
import { GIG_TYPES, REQUIRED_TIER_FOR_GIG, canAccept, categoryOf, fallbackMs, feeOf, isCalloutFee, mustBeLifeSafety } from "./policy";
import { isKnownGigType } from "./validate";
import { EQUIPMENT_LABELS, SKILL_LABELS, TYPE_SMS_LABELS } from "./taxonomy";
import type { Channel, Dispatch, Equipment, GigType, Helper, HelpRequest, LatLng, LocationSource, NeedType, RequestCategory, RequesterRole, StoreErrorReason, TriageResult, Urgency, UserProfile, Skill, TaskScope, JobPhoto } from "./types";

const g = globalThis as unknown as { __resq_locks?: Map<string, Promise<unknown>> };
const locks = (g.__resq_locks ??= new Map());

export function withRequestLock<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(requestId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(requestId, tail);
  void tail.then(() => { if (locks.get(requestId) === tail) locks.delete(requestId); });
  return run;
}

const nowIso = () => new Date().toISOString();
/** Clock-skew tolerance for tick(): 1 s, but never more than a tenth of the window. */
const grace = () => Math.min(TICK_GRACE_MS, waveWindowMs() / 10);
/** Same tolerance for the 3-minute fallback deadline (the requester's screen schedules a tick exactly at the deadline). */
const fallbackGrace = () => Math.min(TICK_GRACE_MS, fallbackMs() / 10);
/** LIFE_SAFETY only: true once the request has been open for fallbackMs() (180 s by default), measured from createdAt. */
function fallbackDue(r: HelpRequest, nowMs = Date.now()): boolean {
  if (categoryOf(r) !== "LIFE_SAFETY") return false;
  const created = Date.parse(r.createdAt);
  return Number.isFinite(created) && nowMs - created >= fallbackMs() - fallbackGrace();
}

// ── SMS wording owned by dispatch (kept here: lib/sms.ts only knows skill pings) ────────────────────────────────
const SMS_MAX = 160;
const expiresIn = () => `Expires in ${Math.round(waveWindowMs() / 1000)} s.`;
/** Ping for someone matched on what they OWN, not on a skill. */
const tplPingEquipment = (i: { distanceKm: number; equipment: Equipment; type: NeedType; urgency: Urgency }) =>
  `RESQ: person ${formatDistance(i.distanceKm)} away needs your ${EQUIPMENT_LABELS[i.equipment].toUpperCase()} (${TYPE_SMS_LABELS[i.type]}, ${i.urgency}). Reply YES to accept, NO to skip. ${expiresIn()}`;
/** Ping for a paid household job ("Rs", not the rupee sign, so the SMS stays one GSM-7 segment). */
const tplPingGig = (i: { distanceKm: number; label: string; fee: number }) =>
  `RESQ: paid job ${formatDistance(i.distanceKm)} away needs a ${i.label.toUpperCase()} (Rs ${i.fee} callout, held in escrow). Reply YES to accept, NO to skip. ${expiresIn()}`;

/**
 * Text for the requester's emergency contact when the fallback fires (docs/UPGRADE.md §6). The contract wording is
 * used when it fits in one 160-character SMS; with a maps link it usually does not, so a compact wording with the
 * same facts is used instead, and the name is shortened as a last resort. Never longer than 160 characters.
 */
export function tplEmergencyContact(i: { name: string | null; type: NeedType; location: LatLng | null }): string {
  const type = TYPE_SMS_LABELS[i.type];
  const where = i.location ? mapsUrl(i.location) : "not shared";
  const full = (n: string) => `RESQ: ${n} asked for emergency help (${type}) and no local helper has responded. Location: ${where}. Please call them or 112.`;
  const compact = (n: string) => `RESQ: ${n} asked for emergency help (${type}). No local helper has responded. Location: ${where} Call them or 112.`;
  const name = (i.name ?? "").trim() || "Your contact";
  if (full(name).length <= SMS_MAX) return full(name);
  if (compact(name).length <= SMS_MAX) return compact(name);
  const first = name.split(/\s+/)[0];
  if (compact(first).length <= SMS_MAX) return compact(first);
  const room = Math.max(1, first.length - (compact(first).length - SMS_MAX));
  return compact(first.slice(0, room)).slice(0, SMS_MAX);
}

// ── internal transitions (call only while holding the lock) ─────────────────────────────────────────────────────

/**
 * Nobody accepted (all 4 waves done, no location, or the 3-minute LIFE_SAFETY deadline): hand over to the coordinator.
 * For a life-safety request this is the "smart fallback": fallbackAt is stamped (the requester's screen shows the
 * call-112 modal) and the requester's emergency contact is texted exactly once. Exactly-once holds because this runs
 * under the request lock and emergencyContactNotifiedAt is persisted here; it is only set when the SMS went out
 * (or was simulated), so the screen never claims a text that failed.
 */
async function escalateLocked(id: string): Promise<HelpRequest | null> {
  const store = getStore();
  const before = await store.getRequest(id);
  if (!before) return null;
  const lifeSafety = categoryOf(before) === "LIFE_SAFETY";
  const first = before.status !== "escalated";
  let r = (await store.updateRequest(id, {
    status: "escalated", waveStartedAt: null,
    ...(lifeSafety && !before.fallbackAt ? { fallbackAt: nowIso() } : {}),
  })) as HelpRequest;
  emit("request:updated", { request: r });
  if (first && r.channel === "sms" && r.requesterPhone) void sendSms(r.requesterPhone, tplRequesterEscalated());
  const contact = r.requesterProfile?.emergencyContactPhone ?? null;
  if (lifeSafety && contact && !r.emergencyContactNotifiedAt) {
    const sent = await sendSms(contact, tplEmergencyContact({ name: r.requesterName, type: r.triage?.type ?? "other", location: r.location }));
    if (sent.ok) {
      r = (await store.updateRequest(id, { emergencyContactNotifiedAt: nowIso() })) as HelpRequest;
      emit("request:updated", { request: r });
    }
  }
  return r;
}

async function runWaveLocked(id: string, first: number): Promise<HelpRequest | null> {
  const store = getStore();
  for (let n = first; n <= MAX_WAVES; n++) {
    const fresh = await store.getRequest(id);
    if (!fresh || fresh.status !== "searching") return fresh;
    const radiusKm = WAVE_RADII_KM[n - 1];
    const now = new Date();
    const request = (await store.updateRequest(id, { wave: n, radiusKm, waveStartedAt: now.toISOString() })) as HelpRequest;
    const existing = await store.listDispatches(id);
    const exclude = new Set(existing.map((d) => d.helperId));
    if (request.requesterHelperId) exclude.add(request.requesterHelperId);
    for (const id of await busyHelperIds()) exclude.add(id); // one job at a time
    const t0 = request.triage;
    const gig = categoryOf(request) === "HOUSEHOLD_MICROGIG";
    const neededEquipment = t0?.equipment ?? [];
    const picks = selectWave({
      request, helpers: await store.getOnDutyHelpers(), radiusKm, excludeHelperIds: exclude, now, neededEquipment,
      // Wave 1 of a critical life-safety request goes to verified first responders first (docs/UPGRADE.md §3).
      prioritizeTier3: !gig && t0?.urgency === "critical" && n === 1,
      // Paid household jobs: only Certified Pros with the trade skill, never a bystander fill.
      ...(gig ? { strict: true, requireTier: REQUIRED_TIER_FOR_GIG } : {}),
    });
    if (picks.length === 0) continue; // nobody to wait for → widen immediately
    const ds: Dispatch[] = picks.map((p) => ({
      id: randomUUID(), requestId: id, helperId: p.helper.id, wave: n, score: +p.score.toFixed(4),
      distanceKm: +p.distanceKm.toFixed(3), channel: "app", status: "pinged", pingedAt: now.toISOString(), respondedAt: null,
    }));
    await store.createDispatches(ds);
    for (const d of ds) emit("dispatch:created", { dispatch: d, request });
    emit("request:updated", { request });
    const t = request.triage;
    if (t) {
      for (const p of picks) {
        const mySkill = t.skills.find((s) => p.helper.skills.includes(s));
        const myEquipment = neededEquipment.find((e) => (p.helper.equipment ?? []).includes(e));
        const body = gig ? tplPingGig({ distanceKm: p.distanceKm, label: SKILL_LABELS[mySkill ?? t.skills[0]], fee: feeOf(request) })
          : !mySkill && myEquipment ? tplPingEquipment({ distanceKm: p.distanceKm, equipment: myEquipment, type: t.type, urgency: t.urgency })
          : tplPing({ distanceKm: p.distanceKm, skill: mySkill ?? t.skills[0], type: t.type, urgency: t.urgency });
        void sendSms(p.helper.phone, body);
        // The text is cheap and everyone gets it; the call costs real money, so it rings only the people this
        // request is genuinely theirs for — a skill or a piece of equipment they own, never a bystander fill.
        if (mySkill || myEquipment) void deliverAlertCall(p.helper.phone, alertPing({ distanceKm: p.distanceKm, skill: mySkill ?? null }), p.helper.language);
      }
    }
    return request;
  }
  return escalateLocked(id);
}

async function expirePinged(id: string): Promise<void> {
  const store = getStore();
  const request = await store.getRequest(id);
  for (const d of await store.listDispatches(id)) {
    if (d.status !== "pinged") continue;
    const u = await store.updateDispatch(d.id, { status: "expired", respondedAt: nowIso() });
    if (u && request) emit("dispatch:updated", { dispatch: u, request });
  }
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────────────────────

export type NewRequestInput = {
  requesterId: string; requesterPhone: string | null; requesterHelperId: string | null; description: string;
  location: LatLng | null; locationSource: LocationSource; landmark: string | null; channel: Channel; role?: RequesterRole;
  requesterName?: string | null;
  requesterProfile?: UserProfile | null;
  category?: RequestCategory; // default LIFE_SAFETY (always free)
  gigType?: GigType | null;   // required for HOUSEHOLD_MICROGIG
  calloutFee?: number;        // one of CALLOUT_FEES for HOUSEHOLD_MICROGIG; ignored (0) for LIFE_SAFETY
};

const URGENCY_ORDER: Urgency[] = ["critical", "high", "medium", "low"];
/** A paid household job is never dispatched as an emergency: critical/high are capped at "medium". */
const capUrgency = (u: Urgency): Urgency => (URGENCY_ORDER.indexOf(u) < URGENCY_ORDER.indexOf("medium") ? "medium" : u);

/** Micro-gig rules (docs/UPGRADE.md §1): the trade decides who is pinged, not the free-text classification. */
function gigTriage(t: TriageResult, gigType: GigType): TriageResult {
  const gig = GIG_TYPES[gigType];
  return { ...t, skills: [...gig.skills], equipment: [...new Set([...gig.equipment, ...(t.equipment ?? [])])].slice(0, 4), urgency: capUrgency(t.urgency) };
}

// ─── Community services (the marketplace flow) ──────────────────────────────────────────────────────────────

export const SERVICE_RADIUS_KM = 10;
export type ServiceRequestInput = {
  service: Skill; description: string; location: LatLng | null; account: Helper;
  // AI-scoped jobs (/api/scope-task): same id as the MongoDB `jobs` document; dispatch is done by the caller.
  id?: string; notify?: boolean; scope?: TaskScope | null; shortCode?: string | null;
  attachments?: JobPhoto[]; answers?: { question: string; answer: string }[]; aiMatchedWorkerIds?: string[];
};

/**
 * Who a service broadcast reaches by SMS: available providers of that service inside SERVICE_RADIUS_KM, nearest 10.
 * It lives here rather than inline in createServiceRequest because notifyTaken has to answer the same question in
 * reverse ("who did we tell about this job?") once somebody takes it, and the two answers must not drift apart.
 */
async function broadcastTargets(i: { service: Skill; location: LatLng; excludeHelperId: string | null }): Promise<{ helper: Helper; km: number }[]> {
  return (await getStore().getOnDutyHelpers())
    .filter((h) => h.id !== i.excludeHelperId && h.skills.includes(i.service) && h.location)
    .map((h) => ({ helper: h, km: haversineKm(i.location, h.location!) }))
    .filter((x) => x.km <= SERVICE_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 10);
}

/**
 * A user tapped a service (plumber, electrician, doctor…) and described the problem. The request is broadcast to
 * every available provider of that service within SERVICE_RADIUS_KM (their dashboard updates live; the nearest 10
 * also get an SMS). It stays open until one of them accepts: no waves, no escalation.
 */
export async function createServiceRequest(input: ServiceRequestInput): Promise<HelpRequest> {
  const store = getStore();
  const now = nowIso();
  const medical = input.service === "doctor" || input.service === "nurse" || input.service === "caregiver";
  const triageResult: TriageResult = {
    type: "other", urgency: medical ? "high" : "medium", skills: [input.service],
    summary: input.description.slice(0, 140), confidence: 1, source: "rules", clarifyingQuestion: null, equipment: [], hazardAlert: NO_HAZARD,
  };
  const request = await store.createRequest({
    id: input.id ?? randomUUID(), requesterId: `acct:${input.account.id}`, requesterPhone: input.account.phone, requesterHelperId: input.account.id,
    requesterName: input.account.name, requesterProfile: input.account.profile ?? null, role: "self",
    description: input.description, location: input.location, locationSource: input.location ? "gps" : "none", landmark: null, channel: "app",
    triage: triageResult, status: "searching", wave: 1, radiusKm: SERVICE_RADIUS_KM, waveStartedAt: now, matchedHelperId: null,
    createdAt: now, updatedAt: now, category: "SERVICE", service: input.service, gigType: null, calloutFee: 0, escrowStatus: null,
    upgradedToLifeSafety: false, fallbackAt: null, emergencyContactNotifiedAt: null, paymentStatus: null,
    scope: input.scope ?? null, shortCode: input.shortCode ?? null, attachments: input.attachments ?? [], answers: input.answers ?? [],
    aiMatchedWorkerIds: input.aiMatchedWorkerIds ?? [],
  });
  emit("request:updated", { request });
  if (input.location && input.notify !== false) {
    for (const { helper, km } of await broadcastTargets({ service: input.service, location: input.location, excludeHelperId: input.account.id })) {
      void sendSms(helper.phone, tplServiceRequest({ service: input.service, distanceKm: km }));
      void deliverAlertCall(helper.phone, alertService({ service: input.service, distanceKm: km }), helper.language); // every broadcast target is a skill match
    }
  }
  return request;
}

export async function createHelpRequest(input: NewRequestInput): Promise<HelpRequest> {
  const store = getStore();
  const now = nowIso();
  // A request only becomes a paid micro-gig when the trade AND the fee are valid (the route rejects anything else with
  // 400). Any other caller input falls back to a free life-safety request: a cry for help is never dropped over money.
  const gigType = input.category === "HOUSEHOLD_MICROGIG" && isKnownGigType(input.gigType) && isCalloutFee(input.calloutFee) ? input.gigType : null;
  const created = await store.createRequest({
    id: randomUUID(), ...input, requesterName: input.requesterName ?? null, requesterProfile: input.requesterProfile ?? null, role: input.role ?? inferRole(input.description), triage: null, status: "triaging", wave: 0, radiusKm: 0, waveStartedAt: null,
    category: gigType ? "HOUSEHOLD_MICROGIG" : "LIFE_SAFETY", gigType, calloutFee: gigType ? (input.calloutFee as number) : 0,
    escrowStatus: gigType ? "HELD" : null, upgradedToLifeSafety: false, fallbackAt: null, emergencyContactNotifiedAt: null,
    matchedHelperId: null, createdAt: now, updatedAt: now,
  });
  emit("request:updated", { request: created });
  if (input.requesterPhone && input.location) {
    await store.recordLocation({ phone: input.requesterPhone, name: input.requesterName ?? null, helperId: input.requesterHelperId,
      location: input.location, accuracyM: null, source: "request", updatedAt: now });
  }
  const raw = await triage(input.description);
  // Safety override: a "paid job" that is really an emergency becomes a FREE life-safety request and the fee is refunded.
  const upgrade = gigType !== null && mustBeLifeSafety(raw, input.description);
  const t = gigType && !upgrade ? gigTriage(raw, gigType) : raw;
  const withTriage = (await store.updateRequest(created.id, {
    triage: t,
    ...(upgrade ? { category: "LIFE_SAFETY" as const, calloutFee: 0, escrowStatus: "REFUNDED" as const, upgradedToLifeSafety: true } : {}),
  })) as HelpRequest;
  emit("request:updated", { request: withTriage });
  const final = input.location ? await startSearch(created.id) : await escalate(created.id);
  return final ?? withTriage;
}

export function startSearch(id: string): Promise<HelpRequest | null> {
  return withRequestLock(id, async () => {
    const store = getStore();
    const r = await store.getRequest(id);
    if (!r || r.status !== "triaging") return r;
    await store.updateRequest(id, { status: "searching", wave: 0 });
    return runWaveLocked(id, 1);
  });
}

export function tick(id: string): Promise<{ advanced: boolean; request: HelpRequest | null }> {
  return withRequestLock(id, async () => {
    const store = getStore();
    const r = await store.getRequest(id);
    if (!r || r.status !== "searching") return { advanced: false, request: r };
    if (categoryOf(r) === "SERVICE") return { advanced: false, request: r }; // service requests stay open until accepted
    if (fallbackDue(r)) { // 3-minute smart fallback: escalate at once, even mid-wave
      await expirePinged(id);
      return { advanced: true, request: await escalateLocked(id) };
    }
    const elapsed = r.waveStartedAt === null || Date.now() - Date.parse(r.waveStartedAt) >= waveWindowMs() - grace();
    const ds = await store.listDispatches(id);
    if (!elapsed && ds.some((d) => d.wave === r.wave && d.status === "pinged")) return { advanced: false, request: r };
    await expirePinged(id);
    const next = r.wave < MAX_WAVES ? await runWaveLocked(id, r.wave + 1) : await escalateLocked(id);
    return { advanced: true, request: next };
  });
}

export async function onReject(dispatchId: string, via: Channel = "app"): Promise<{ ok: true; dispatch: Dispatch } | { ok: false; reason: "expired" | "not_found" }> {
  const d0 = await getStore().getDispatch(dispatchId);
  if (!d0) return { ok: false, reason: "not_found" };
  return withRequestLock(d0.requestId, async () => {
    const store = getStore();
    const d = await store.getDispatch(dispatchId);
    if (!d) return { ok: false as const, reason: "not_found" as const };
    if (d.status !== "pinged") return { ok: false as const, reason: "expired" as const };
    const u = (await store.updateDispatch(d.id, { status: "rejected", respondedAt: nowIso(), ...(via === "sms" ? { channel: "sms" as const } : {}) })) as Dispatch;
    const r = await store.getRequest(d.requestId);
    if (r) emit("dispatch:updated", { dispatch: u, request: r });
    if (r && r.status === "searching" && d.wave === r.wave) {
      const stillPinged = (await store.listDispatches(r.id)).some((x) => x.wave === r.wave && x.status === "pinged");
      if (!stillPinged) { if (r.wave < MAX_WAVES) await runWaveLocked(r.id, r.wave + 1); else await escalateLocked(r.id); }
    }
    return { ok: true as const, dispatch: u };
  });
}

export type AcceptOk = { ok: true; request: HelpRequest; dispatch: Dispatch; location: LatLng | null; mapsUrl: string | null; requesterPhone: string | null };

/** "tier_required": the request is a paid micro-gig and the helper is not a TIER_2_CERTIFIED_PRO (policy canAccept). */
export type AcceptFailReason = StoreErrorReason | "tier_required" | "busy";

/** Helpers who are already on a job (matched to an open request). They are not pinged and cannot take another. */
export async function busyHelperIds(): Promise<Set<string>> {
  return new Set((await getStore().listOpenRequests()).filter((r) => r.status === "matched" && r.matchedHelperId).map((r) => r.matchedHelperId as string));
}
async function isBusyElsewhere(helperId: string, requestId: string): Promise<boolean> {
  return (await getStore().listOpenRequests()).some((r) => r.status === "matched" && r.matchedHelperId === helperId && r.id !== requestId);
}
export type ClaimFailReason = AcceptFailReason | "own_request" | "service_mismatch";
export type AcceptResult = AcceptOk | { ok: false; reason: AcceptFailReason };
export type ClaimResult = AcceptOk | { ok: false; reason: ClaimFailReason };

export async function accept(dispatchId: string, via: Channel = "app"): Promise<AcceptResult> {
  const d0 = await getStore().getDispatch(dispatchId);
  if (!d0) return { ok: false, reason: "not_found" };
  return withRequestLock(d0.requestId, () => acceptLocked(dispatchId, via));
}

async function acceptLocked(dispatchId: string, via: Channel): Promise<AcceptResult> {
  const store = getStore();
  const d = await store.getDispatch(dispatchId);
  if (!d) return { ok: false, reason: "not_found" };
  const [target, who] = await Promise.all([store.getRequest(d.requestId), store.getHelper(d.helperId)]);
  if (target && !canAccept(who ?? {}, target)) return { ok: false, reason: "tier_required" };
  if (await isBusyElsewhere(d.helperId, d.requestId)) return { ok: false, reason: "busy" };
  const res = await store.acceptDispatch(dispatchId);
  if (!res.ok) return res;
  const dispatch = via === "sms" ? ((await store.updateDispatch(dispatchId, { channel: "sms" })) as Dispatch) : res.dispatch;
  const request = res.request;
  emit("dispatch:updated", { dispatch, request });
  for (const c of res.cancelled) emit("dispatch:updated", { dispatch: c, request });
  emit("request:updated", { request });
  if (request.channel === "sms" && request.requesterPhone) {
    const h = await store.getHelper(dispatch.helperId);
    const skill = h && request.triage ? request.triage.skills.find((s) => h.skills.includes(s)) ?? h.skills[0] ?? request.triage.skills[0] : null;
    if (h && skill) void sendSms(request.requesterPhone, tplRequesterMatched({ name: h.name, skill, distanceKm: dispatch.distanceKm, phone: h.phone }));
  }
  // The job is off the market: tell everyone else who was alerted. Not awaited, so a slow SMS gateway neither
  // holds the request lock open nor can fail an accept that has already happened.
  void notifyTaken(request, dispatch.helperId);
  return { ok: true as const, request, dispatch, location: request.location, mapsUrl: request.location ? mapsUrl(request.location) : null, requesterPhone: request.requesterPhone };
}

/**
 * A neighbour who saw the request in their feed takes it, even if dispatch did not ping them (or it escalated).
 * Reuses their pinged dispatch if they have one; otherwise creates one and accepts it atomically.
 */
export async function claim(requestId: string, helperId: string): Promise<ClaimResult> {
  return withRequestLock(requestId, async () => {
    const store = getStore();
    const r = await store.getRequest(requestId);
    if (!r) return { ok: false as const, reason: "not_found" as const };
    if (r.requesterHelperId === helperId) return { ok: false as const, reason: "own_request" as const };
    if (r.status !== "searching" && r.status !== "escalated") return { ok: false as const, reason: "already_matched" as const };
    // Checked before a dispatch is created, so a refused claim leaves no trace and the request keeps searching.
    if (!canAccept((await store.getHelper(helperId)) ?? {}, r)) return { ok: false as const, reason: categoryOf(r) === "SERVICE" ? "service_mismatch" as const : "tier_required" as const };
    if (await isBusyElsewhere(helperId, requestId)) return { ok: false as const, reason: "busy" as const };
    const mine = (await store.listDispatches(requestId)).find((d) => d.helperId === helperId && d.status === "pinged");
    let id = mine?.id;
    if (!id) {
      const h = await store.getHelper(helperId);
      const d: Dispatch = { id: randomUUID(), requestId, helperId, wave: r.wave, score: 0,
        distanceKm: h?.location && r.location ? +haversineKm(h.location, r.location).toFixed(3) : 0,
        channel: "app", status: "pinged", pingedAt: nowIso(), respondedAt: null };
      await store.createDispatches([d]);
      id = d.id;
    }
    return acceptLocked(id, "app");
  });
}

const gd = globalThis as unknown as { __resq_declines?: Map<string, Set<string>> };
const declines = (gd.__resq_declines ??= new Map());
export const hasDeclined = (requestId: string, helperId: string) => declines.get(requestId)?.has(helperId) ?? false;

/** "Not now": hide the request from this person; if dispatch had pinged them, it counts as a reject. */
export async function decline(requestId: string, helperId: string): Promise<void> {
  if (!declines.has(requestId)) declines.set(requestId, new Set());
  declines.get(requestId)!.add(helperId);
  const pinged = (await getStore().listDispatches(requestId)).find((d) => d.helperId === helperId && d.status === "pinged");
  if (pinged) await onReject(pinged.id);
}

type Simple = { ok: true; request: HelpRequest } | { ok: false; reason: "conflict" | "not_found" };

/**
 * Somebody took this job, so it must stop existing for everyone else. In the app that is already true — the feed
 * only lists "searching" requests and every dashboard is re-pushed on request:updated — but a provider who was
 * alerted by SMS has no feed: the text in their inbox is the whole job, and it keeps inviting them to reply ACCEPT
 * long after the work is gone. This closes that gap.
 *
 * The recipients are everyone the alert could have reached: helpers with a dispatch on the request (the wave pings),
 * the providers a service broadcast covers, and, for an AI-scoped job, the offline workers the scope-task dispatcher
 * texted (recorded in MongoDB, so it is imported lazily and its failure is never allowed to matter). A service
 * broadcast keeps no roster, so that set is recomputed and may have drifted — someone who came on duty since could
 * get a notice about a job they never heard of. That is the right way to be wrong: a stray "nothing for you to do"
 * costs one SMS, while a missed one leaves a worker holding a dead job. Fire-and-forget; never throws.
 */
async function notifyTaken(r: HelpRequest, winnerHelperId: string): Promise<void> {
  try {
    const store = getStore();
    const winner = await store.getHelper(winnerHelperId);
    const label = r.service ? SKILL_LABELS[r.service] : r.triage ? TYPE_SMS_LABELS[r.triage.type] : "help";
    const skipPhones = new Set([winner?.phone, r.requesterPhone].filter((p): p is string => !!p));
    const out = new Map<string, number | null>(); // phone → distance for the wording; a phone is texted at most once
    const add = (phone: string | null | undefined, km: number | null, helperId: string | null) => {
      if (!phone || skipPhones.has(phone)) return;
      if (helperId && (helperId === winnerHelperId || helperId === r.requesterHelperId || hasDeclined(r.id, helperId))) return;
      if (!out.has(phone)) out.set(phone, km);
    };
    for (const d of await store.listDispatches(r.id)) {
      if (d.status === "rejected") continue; // they already said no; do not text them again
      add((await store.getHelper(d.helperId))?.phone, d.distanceKm, d.helperId);
    }
    // A scoped job is dispatched by /api/scope-task (notify: false), never broadcast, so the two are exclusive.
    if (r.service && r.location && !r.shortCode) {
      for (const t of await broadcastTargets({ service: r.service, location: r.location, excludeHelperId: r.requesterHelperId }))
        add(t.helper.phone, t.km, t.helper.id);
    }
    if (r.shortCode) {
      try {
        const job = await (await import("./jobs")).getJob(r.id);
        for (const w of job?.matchedWorkers ?? []) {
          if (w.channel !== "sms") continue; // workers with the app open watched it disappear from their dashboard
          add((await store.getHelper(w.workerId))?.phone, w.distanceKm, w.workerId);
        }
      } catch (e) {
        console.error("[waves] taken notice: scoped-job lookup failed", e);
      }
    }
    for (const [phone, km] of out) void sendSms(phone, tplJobTaken({ label, distanceKm: km }));
  } catch (e) {
    console.error("[waves] taken notice failed", e);
  }
}

/**
 * A request is closed (done or cancelled): the app feeds drop it on the next snapshot, and everyone who was pinged
 * by SMS gets a "no action needed" text so their phone does not keep asking them to help. Skips the helper who
 * took the job and anyone who already declined. Fire-and-forget; never throws.
 */
async function notifyClosed(r: HelpRequest, outcome: "resolved" | "cancelled"): Promise<void> {
  try {
    const store = getStore();
    const typeLabel = r.triage ? TYPE_SMS_LABELS[r.triage.type] : "emergency";
    const helperIds = new Set((await store.listDispatches(r.id))
      .filter((d) => d.helperId !== r.matchedHelperId && d.status !== "rejected")
      .map((d) => d.helperId));
    for (const id of helperIds) {
      const h = await store.getHelper(id);
      if (h?.phone) void sendSms(h.phone, tplRequestClosed({ typeLabel, outcome }));
    }
  } catch (e) {
    console.error("[waves] closure notice failed", e);
  }
}

export function cancel(id: string): Promise<Simple> {
  return withRequestLock(id, async () => {
    const store = getStore();
    const r = await store.getRequest(id);
    if (!r) return { ok: false, reason: "not_found" };
    if (!["triaging", "searching", "matched", "escalated"].includes(r.status)) return { ok: false, reason: "conflict" };
    for (const d of await store.listDispatches(id)) {
      if (d.status !== "pinged") continue;
      const u = await store.updateDispatch(d.id, { status: "cancelled", respondedAt: nowIso() });
      if (u) emit("dispatch:updated", { dispatch: u, request: r });
    }
    const request = (await store.updateRequest(id, { status: "cancelled", waveStartedAt: null, ...(r.escrowStatus === "HELD" ? { escrowStatus: "REFUNDED" as const } : {}) })) as HelpRequest;
    emit("request:updated", { request });
    void notifyClosed(request, "cancelled");
    return { ok: true, request };
  });
}

export function resolve(id: string): Promise<Simple> {
  return withRequestLock(id, async () => {
    const store = getStore();
    const r = await store.getRequest(id);
    if (!r) return { ok: false, reason: "not_found" };
    if (r.status !== "matched") return { ok: false, reason: "conflict" };
    let request = (await store.updateRequest(id, { status: "resolved", ...(categoryOf(r) === "SERVICE" ? { paymentStatus: "due" as const } : {}) })) as HelpRequest;
    // Mark as done = pay the helper. Same lock, so this and POST /api/incident/payout can never both credit.
    const released = await releaseEscrowLocked(id);
    if (released.ok) request = released.request;
    if (!released.ok || released.alreadyReleased) emit("request:updated", { request }); // a fresh release already emitted it
    void notifyClosed(request, "resolved");
    return { ok: true, request };
  });
}

/** POST /api/incident/payout. Idempotent: the first call after "resolved" credits the helper, later calls only report. */
export function payout(requestId: string): Promise<EscrowRelease> {
  return withRequestLock(requestId, () => releaseEscrowLocked(requestId));
}

export function rate(id: string, stars: number): Promise<{ ok: true; request: HelpRequest; helper: Helper | null } | { ok: false; reason: "conflict" | "not_found" }> {
  return withRequestLock(id, async () => {
    const store = getStore();
    const r = await store.getRequest(id);
    if (!r) return { ok: false, reason: "not_found" };
    if (r.status !== "resolved" || !r.matchedHelperId) return { ok: false, reason: "conflict" };
    await store.saveRating({ id: randomUUID(), requestId: id, helperId: r.matchedHelperId, stars, createdAt: nowIso() });
    const helperId = r.matchedHelperId;
    const helper = await withHelperLock(helperId, async () => { // same lock as the wallet credit: neither write can clobber the other
      const h = await store.getHelper(helperId);
      return h ? store.upsertHelper({ ...h, reliability: +(0.8 * h.reliability + 0.2 * (stars / 5)).toFixed(4) }) : null;
    });
    if (helper) emit("helper:updated", { helper });
    return { ok: true, request: r, helper };
  });
}

export function escalate(id: string): Promise<HelpRequest | null> {
  return withRequestLock(id, () => escalateLocked(id));
}

export async function tickDueRequests(): Promise<number> {
  let n = 0;
  for (const r of await getStore().listOpenRequests()) {
    if (r.status !== "searching" || categoryOf(r) === "SERVICE") continue;
    if (!fallbackDue(r) && r.waveStartedAt && Date.now() - Date.parse(r.waveStartedAt) < waveWindowMs() - grace()) continue;
    if ((await tick(r.id)).advanced) n++;
  }
  return n;
}
