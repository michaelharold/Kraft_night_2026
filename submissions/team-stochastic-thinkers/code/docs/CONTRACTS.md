# Sahaya — implementation contracts

This document pins down everything README.md leaves open so that independent people (or agents) can build
separate files that fit together. README.md wins on any conflict; this file wins over any individual's taste.
Section numbers like "§5" refer to README.md.

Environment facts: Node 26 (runs `.ts` files natively via type stripping), Next 16.3 (App Router, Turbopack dev,
route params and `cookies()` are **async**), React 19.3, Tailwind 4.3 (`@tailwindcss/postcss`), TypeScript 5.9,
`twilio` 6.1. The project directory path contains a space — always quote paths in shell commands.

Deviations from README (all intentional; each names the README line that justifies it, so reviewers need not
re-litigate them):
- Routes not in §9: `GET /api/config` (the browser needs `SEED_CENTER_*` and the wave window, §10 rule 7);
  `GET /api/triage` (warm-up, so M1's "< 4 s" holds on a cold model); `GET /api/helpers/me` (helper page needs its
  id and cards after cookie login, §6 identity); `POST /api/ops/login` + `GET /api/ops/stream` (§7 diagram
  `API -->|SSE| O`; EventSource cannot send headers); `PATCH /api/requests/:id` (§3 "marks the job done, gets
  rated", §8 statuses `resolved`/`cancelled`); `POST /api/auth/logout` (**optional, do not block on it**).
- Files not in §9: `lib/waves.ts` (the §5 state machine in one place), `lib/auth.ts`, `lib/views.ts` (one builder
  per wire view), `lib/validate.ts` (§10 rule 6), `lib/client/sse.ts` (§6 realtime), optional `scripts/check-rules.ts`.
- Store additions to §9: `getHelperByPhone` (OTP + inbound `From`), `listHelpers` (ops map/coverage, §3),
  `getDispatch` (respond needs one row), `saveRating` (§3), wider `acceptDispatch` return (emits need the cancelled rows).
- Type additions to §8: `Request` renamed `HelpRequest`; `requesterPhone`, `requesterHelperId`, `locationSource`,
  `landmark`, `waveStartedAt` on the request; `Dispatch.distanceKm`; `TriageResult.clarifyingQuestion` (§4 "one
  fixed clarifying question"); `Otp.attempts`; 12 guidance cards (`other` is the 12th, see §7).

---

## 1. Constants (`lib/taxonomy.ts` and `lib/dispatch.ts`)

```ts
// lib/taxonomy.ts
export const SKILLS = ["doctor","nurse","first_aid","swimmer","boat_owner","electrician","plumber",
                       "driver_4x4","generator_owner","counselor","volunteer"] as const;
export const NEED_TYPES = ["flood_rescue","cardiac_no_breathing","bleeding","fracture","electrical","fire",
                           "trapped_structural","snakebite","evacuation_mobility","supplies_oxygen_meds",
                           "missing_person","other"] as const;
export const URGENCIES = ["critical","high","medium","low"] as const;
export const TYPE_SKILLS: Record<NeedType, Skill[]>   // default skills per type, e.g.
//  flood_rescue: ["swimmer","boat_owner","first_aid"]        cardiac_no_breathing: ["doctor","nurse","first_aid"]
//  bleeding: ["nurse","doctor","first_aid"]                   fracture: ["nurse","doctor","first_aid","driver_4x4"]
//  electrical: ["electrician","first_aid"]                    fire: ["volunteer","first_aid","driver_4x4"]
//  trapped_structural: ["volunteer","first_aid","driver_4x4"] snakebite: ["doctor","nurse","driver_4x4"]
//  evacuation_mobility: ["boat_owner","swimmer","driver_4x4"] supplies_oxygen_meds: ["driver_4x4","volunteer","nurse"]
//  missing_person: ["volunteer","counselor"]                  other: ["volunteer","first_aid"]
export const SKILL_LABELS: Record<Skill, string>      // "boat_owner" -> "Boat owner", "driver_4x4" -> "4×4 driver"
export const TYPE_LABELS: Record<NeedType, string>    // "cardiac_no_breathing" -> "Cardiac arrest / not breathing"
export const TYPE_SMS_LABELS: Record<NeedType, string> // ≤ 12 chars, used only inside SMS: flood_rescue -> "flood",
//  cardiac_no_breathing -> "cardiac", bleeding -> "bleeding", fracture -> "fracture", electrical -> "electrical",
//  fire -> "fire", trapped_structural -> "trapped", snakebite -> "snakebite", evacuation_mobility -> "evacuation",
//  supplies_oxygen_meds -> "supplies", missing_person -> "missing", other -> "emergency"
export const CLARIFYING_QUESTION = "Is anyone hurt, trapped, or in water right now? Tell me what you see.";
export const isSkill(x: unknown): x is Skill; isNeedType; isUrgency   // hand-written guards
```

```ts
// lib/dispatch.ts
export const WAVE_RADII_KM = [1, 2, 4, 8] as const;   // index = wave - 1
export const MAX_WAVES = 4;
export const PINGS_PER_WAVE = 3;
export const WAVE_WINDOW_MS = Number(process.env.RESQ_WAVE_WINDOW_MS ?? 30_000);
export const TICK_GRACE_MS = 1_000;                   // tolerance for clock skew / timer jitter (see §4 tick)
export const RECENCY_WINDOW_MS = 10 * 60_000;
export const INITIAL_RELIABILITY = 0.7;
export const SEED_CENTER_DEFAULT: LatLng = { lat: 8.913, lng: 76.635 };
export function getSeedCenter(): LatLng;              // SEED_CENTER_LAT/LNG when both parse as finite numbers, else SEED_CENTER_DEFAULT
```

## 2. Types (`lib/types.ts`)

All timestamps are ISO-8601 strings (JSON-safe, adapter-agnostic). Ids are `crypto.randomUUID()` except seeded
helpers (`seed-helper-01` … `seed-helper-30`). The README's `Request` entity is named **`HelpRequest`** in code
because `Request` collides with the Fetch API global.

```ts
export type Skill = (typeof SKILLS)[number];  export type NeedType = ...;  export type Urgency = ...;
export type LatLng = { lat: number; lng: number };
export type Channel = "app" | "sms";

export type Helper = {
  id: string; name: string; phone: string;          // phone is E.164, e.g. "+919000000001"
  skills: Skill[]; location: LatLng | null; onDuty: boolean;
  reliability: number;                              // 0..1, starts 0.7
  lastSeen: string;
};

export type TriageResult = {
  type: NeedType; urgency: Urgency; skills: Skill[];  // skills never empty: falls back to TYPE_SKILLS[type]
  summary: string; confidence: number;                // 0..1
  source: "ollama" | "rules";
  clarifyingQuestion: string | null;                  // CLARIFYING_QUESTION when source==="rules" && confidence < 0.5; never blocks dispatch (§6)
};

export type RequestStatus = "triaging" | "searching" | "matched" | "resolved" | "escalated" | "cancelled";
export type LocationSource = "gps" | "landmark" | "none";

export type HelpRequest = {
  id: string; requesterId: string;                    // app: x-resq-uid; sms: "sms:+91..."
  requesterPhone: string | null;                      // set for channel "sms" so we can text updates back; null for app requests
  requesterHelperId: string | null;                   // the requester's own helper record, if any — excluded from selectWave.
                                                      // app: getHelperSession(req)?.helperId ?? null (browser sends resq_session automatically);
                                                      // sms: (await store.getHelperByPhone(phone))?.id ?? null
  description: string; location: LatLng | null; locationSource: LocationSource; landmark: string | null;
  channel: Channel; triage: TriageResult | null; status: RequestStatus;
  wave: number;                                       // 0 before dispatch starts, 1..4 while searching
  radiusKm: number;                                   // WAVE_RADII_KM[wave-1], 0 before dispatch
  waveStartedAt: string | null;                       // when the current wave's pings went out; null before wave 1 and after escalate
  matchedHelperId: string | null;
  createdAt: string; updatedAt: string;
};

export type DispatchStatus = "pinged" | "accepted" | "rejected" | "expired" | "cancelled";
export type Dispatch = {
  id: string; requestId: string; helperId: string; wave: number; score: number; distanceKm: number;
  channel: Channel;                                   // records how the helper answered: created as "app"; the inbound webhook
                                                      // sets it to "sms" on the dispatch it accepts or rejects (waves.accept / waves.onReject
                                                      // with via: "sms"). Shown as a badge on /ops; nothing else reads it.
  status: DispatchStatus; pingedAt: string; respondedAt: string | null;
};

export type Rating = { id: string; requestId: string; helperId: string; stars: number; createdAt: string };
export type Otp = { phone: string; code: string; expiresAt: string; attempts: number };   // attempts = wrong tries so far, starts 0

// Wire shapes (what routes return). Defined here so client and server share them.
export type GuidanceCard = { type: NeedType; title: string; steps: string[]; doNot: string[]; call112When: string[]; source: string };
export type DispatchPublic = Pick<Dispatch, "id" | "wave" | "status" | "distanceKm" | "pingedAt"> & { helperSkills: Skill[] };  // no name/phone
export type HelperPublic = Pick<Helper, "id" | "name" | "skills" | "phone"> & { distanceKm: number | null };  // distanceKm = the accepted dispatch's distanceKm
export type RequestView = {                          // GET /api/requests/:id, POST .../tick, requester SSE snapshot
  request: HelpRequest; dispatches: DispatchPublic[]; guidance: GuidanceCard | null; matchedHelper: HelperPublic | null;
  waveEndsAt: string | null;                          // waveStartedAt + WAVE_WINDOW_MS while status === "searching"; null otherwise
};
export type IncomingCard = {                          // helper SSE snapshot item / GET /api/helpers/me
  dispatch: Dispatch;
  request: Pick<HelpRequest, "id" | "description" | "triage" | "status" | "createdAt" | "wave">;
  expiresAt: string;                                  // dispatch.pingedAt + WAVE_WINDOW_MS
};
export type HelperView = { helper: Helper | null; pinged: IncomingCard[]; active: { request: HelpRequest; mapsUrl: string | null } | null };
export type OpsView = { requests: HelpRequest[]; helpers: Helper[]; dispatches: Dispatch[]; center: LatLng; generatedAt: string };
export type StoreErrorReason = "already_matched" | "expired" | "not_found";
```

**View builders — `lib/views.ts` (M2) is the only place that assembles wire views.** GET routes, `tick`, `PATCH`,
the three SSE routes and the ops stream all call these; no route builds a view by hand:
- `buildRequestView(requestId, now): Promise<RequestView | null>` — `dispatches` = `listDispatches(id)` mapped to
  `DispatchPublic` (`helperSkills` from `getHelper`), `guidance` = `getGuidance(triage.type)` or null, `matchedHelper`
  = the matched helper with `distanceKm` of the accepted dispatch, `waveEndsAt` as defined above.
- `buildHelperView(helperId: string | null, now): Promise<HelperView>` — `helper` = `getHelper(id)` (null when the
  phone is verified but not registered yet); `pinged` = `listPingedForHelper(id)` mapped to `IncomingCard`, **excluding
  cards whose request status is not `searching`**, newest first (greatest `pingedAt`, ties by `id`); `active` = newest
  row of `listOpenRequests()` with `status === "matched"` and `matchedHelperId === id` (null otherwise), `mapsUrl` =
  `mapsUrl(request.location)` or null when the location is null.
- `buildOpsView(now): Promise<OpsView>` — `requests` = `listOpenRequests()` **exactly** (README §9: open + escalated;
  resolved/cancelled requests are not returned), `dispatches` = `listDispatches` of each included request, `helpers` =
  `listHelpers()`, `center` = `getSeedCenter()`.

## 3. Store interface (`lib/store/index.ts`) — README §9 plus four necessary additions

```ts
export interface Store {
  upsertHelper(h: Helper): Promise<Helper>;
  getHelper(id: string): Promise<Helper | null>;
  getHelperByPhone(phone: string): Promise<Helper | null>;   // ADDITION: inbound SMS and OTP login identify helpers by phone
  listHelpers(): Promise<Helper[]>;                          // ADDITION: ops map shows every helper, on duty or not
  getOnDutyHelpers(): Promise<Helper[]>;                     // onDuty && location !== null
  setOnDuty(id: string, onDuty: boolean, location?: LatLng | null): Promise<Helper | null>;  // also bumps lastSeen

  createRequest(r: HelpRequest): Promise<HelpRequest>;
  getRequest(id: string): Promise<HelpRequest | null>;
  updateRequest(id: string, patch: Partial<HelpRequest>): Promise<HelpRequest | null>;   // sets updatedAt
  listOpenRequests(): Promise<HelpRequest[]>;                // status in triaging|searching|matched|escalated, newest first

  createDispatches(ds: Dispatch[]): Promise<Dispatch[]>;
  getDispatch(id: string): Promise<Dispatch | null>;         // ADDITION: reject/respond must load one dispatch
  listDispatches(requestId: string): Promise<Dispatch[]>;
  listPingedForHelper(helperId: string): Promise<Dispatch[]>;   // status === "pinged" only
  updateDispatch(id: string, patch: Partial<Dispatch>): Promise<Dispatch | null>;
  acceptDispatch(dispatchId: string): Promise<
    | { ok: true; request: HelpRequest; dispatch: Dispatch; cancelled: Dispatch[] }
    | { ok: false; reason: StoreErrorReason }>;

  saveRating(r: Rating): Promise<Rating>;                    // ADDITION: §3 "gets rated"; one rating per requestId, a later call replaces it (last wins)
  saveOtp(o: Otp): Promise<void>;                            // replaces any existing code for that phone (attempts reset to 0)
  verifyOtp(phone: string, code: string): Promise<boolean>;  // true consumes the code; expired/missing/wrong -> false.
                                                             // A wrong code increments attempts; the 5th wrong attempt deletes the code.
}
export function getStore(): Store;   // globalThis singleton (see §8); STORE env: "memory" (default); anything else throws "adapter not purchased"
```

`acceptDispatch` semantics (must hold for every adapter, and MemoryStore implements it with **no `await` between
the check and the writes** so two concurrent calls cannot both succeed):
1. dispatch missing → `not_found`. 2. `dispatch.status === "cancelled"` → `already_matched` (someone else won the
race and the winner's step 5 already cancelled this row); any other status that is not `pinged` (`accepted`, `rejected`,
`expired`) → `expired`. 3. request missing → `not_found`. 4. `request.status !== "searching"` → `already_matched`.
5. Otherwise set dispatch `accepted` + `respondedAt`, request `matched` + `matchedHelperId`, every other dispatch of
that request with status `pinged` → `cancelled` (+ `respondedAt`), return them in `cancelled`.

**Ownership of objects.** MemoryStore never hands out or retains caller-owned references: every read returns
`structuredClone` of the stored value and every write stores a clone of the argument (`acceptDispatch` mutates only
the internal maps, still with no `await`). Callers persist state only through `updateRequest` / `updateDispatch` /
`upsertHelper` / `setOnDuty`; in-place mutation of a fetched object is never persisted. DB adapters behave this way by
nature. The store never emits events (see §5).

## 4. Dispatch rules (`lib/dispatch.ts`)

- `haversineKm(a: LatLng, b: LatLng): number`.
- `scoreHelper(input: { helper: Helper; needed: Skill[]; distanceKm: number; radiusKm: number; now: Date }): { score: number; skillMatch: number }`
  using the §5 formula exactly: `0.45*skillMatch + 0.30*max(0, 1 - distance/radius) + 0.15*reliability + 0.10*recency`,
  `recency = 1` if `now - lastSeen < 10 min` else `0.5`.
- `selectWave(input: { request: HelpRequest; helpers: Helper[]; radiusKm: number; excludeHelperIds: Set<string>; now: Date }): Array<{ helper: Helper; score: number; distanceKm: number }>`
  → returns `[]` when `request.location` or `request.triage` is null. Otherwise candidates = on-duty helpers with a
  location, within `radiusKm`, not in `excludeHelperIds`. **Ranking: sort by `score` desc, then `distanceKm` asc, then
  `id` asc (deterministic); take the first `PINGS_PER_WAVE`. No other ordering rule** (§5 "ping top 3" is defined purely
  by `score`).
- `excludeHelperIds` (computed by `runWave` on every wave, never taken from a route) = every `helperId` that has a
  dispatch for this request in any status ∪ `{ request.requesterHelperId }` when it is not null.
- Pure functions only: no store access, no I/O, no `Date.now()` inside (take `now` as input) so they are unit-testable.

### Wave state machine (implemented once, in `lib/waves.ts`, used by create, tick, respond, PATCH and the webhook)

**Locking.** `lib/waves.ts` serialises all transitions per request with an in-process mutex
`withRequestLock(requestId, fn)`: a `Map<string, Promise<unknown>>` chain stored on `globalThis.__resq_locks`, each
call chained onto the previous promise for that id, the entry deleted when its chain drains. `startSearch`, `tick`,
`onReject`, `accept`, `cancel` and `escalate` each acquire it, **re-read the request and its dispatches from the store
inside the locked section**, and never trust objects a route passed in. `runWave` is only ever called inside the lock
and returns without writing when the fresh `request.status !== "searching"`. Within one transition all writes are
persisted (request first, then dispatches) **before** any event is emitted. Routes and the webhook only validate
identity and call these functions; **nothing outside `lib/waves.ts` calls `store.acceptDispatch`, changes a dispatch
status, or changes `request.status`/`wave`.**

```
startSearch(requestId)       : under lock: status "searching", wave 0 → runWave(1)
runWave(request, n)          : (inside the lock only; no-op if fresh status !== "searching")
                               radius = WAVE_RADII_KM[n-1]; wave = n; radiusKm; waveStartedAt = now; persist request;
                               picks = selectWave(...); create Dispatch rows (status "pinged", channel "app", score, distanceKm,
                               pingedAt = now); emit dispatch:created per pick, then request:updated;
                               send tplPing per pick (fire-and-forget);
                               if picks.length === 0:  n < MAX_WAVES ? runWave(request, n+1)   // nobody to wait for → widen now
                                                                    : escalate(request)
tick(requestId)              : under lock, re-read: if status !== "searching" → { advanced: false }
                               elapsed = waveStartedAt === null
                                         || now - Date.parse(waveStartedAt) >= WAVE_WINDOW_MS - TICK_GRACE_MS
                               if !elapsed and some dispatch with wave === request.wave is "pinged" → { advanced: false }
                               else every "pinged" dispatch of the request (ANY wave) → "expired" (+respondedAt),
                                    emit dispatch:updated each; then wave < MAX_WAVES ? runWave(wave+1) : escalate;
                                    → { advanced: true }
onReject(dispatchId, via = "app")
                             : under lock, re-read dispatch + request; dispatch.status !== "pinged" → { ok: false, reason: "expired" }
                               dispatch → "rejected" + respondedAt (+ channel = "sms" when via === "sms"); emit dispatch:updated;
                               if request.status !== "searching" or dispatch.wave !== request.wave → stop (return ok);
                               else if no dispatch with wave === request.wave is still "pinged" →
                                    wave < MAX_WAVES ? runWave(wave+1) : escalate      // §5 "all 3 reject → next wave immediately"
accept(dispatchId, via = "app")
                             : under lock: r = store.acceptDispatch(id); if !r.ok → return r (respond: 409; webhook: text reply)
                               if via === "sms": updateDispatch(id, { channel: "sms" });
                               emit dispatch:updated for r.dispatch and for each row of r.cancelled, then request:updated;
                               if request.channel === "sms": sendSms(requesterPhone, tplRequesterMatched(...)) fire-and-forget;
                               return { ok: true, request, dispatch, location: request.location, mapsUrl, requesterPhone }
cancel(requestId)            : under lock: allowed from triaging|searching|matched|escalated (else { ok: false, reason: "conflict" });
                               every "pinged" dispatch → "cancelled" (+respondedAt, dispatch:updated each);
                               status "cancelled", waveStartedAt = null; emit request:updated
escalate(request)            : status "escalated", waveStartedAt = null; emit request:updated;
                               SMS the requester (tplRequesterEscalated) if channel sms
```

Rules that follow from the above:
- `tick` is idempotent **under the lock**: concurrent or repeated calls advance a wave at most once (exactly one of
  them returns `advanced: true`). The 1 s grace (`TICK_GRACE_MS`) means a tick that lands just before the window
  boundary still advances; `waveEndsAt` stays `waveStartedAt + WAVE_WINDOW_MS`.
- **A single reject never back-fills the slot** (README §5 "ping top 3" per wave; §10 rule 5 "the only immediate
  transition"). README §13 step 4 ("next candidate pinged instantly") is only literally true when the reject was the
  last pinged one of the wave; the demo relies instead on **both demo helper phones being inside wave 1's top 3**, which
  the seed constraints in §7 guarantee (full skill match at the venue against seeded helpers capped at ≈ 0.75). Pitch
  owner: reword §13 step 4 to "Helper 1 taps **Reject**; Helper 2 (also pinged in wave 1) replies **YES** by SMS."
- **Empty-wave rule** (intentional; the vacuous case of §10 rule 5 "all pinged rejected"): when `selectWave` returns
  no candidates the next wave starts at once, so a request with no on-duty helpers within 8 km is returned by
  `POST /api/requests` already `escalated` with `wave: 4`, `radiusKm: 8` and zero dispatches. M2's "4 empty waves →
  escalated" is verified on the create response, not with four ticks (§11.1). Docs owner: add this sentence to README
  §10 rule 5.
- A request created with `location: null` skips `startSearch` and goes straight to `escalated` (coordinator must
  handle it); `wave` stays 0.
- `clarifyingQuestion` never blocks dispatch: `POST /api/requests` runs `startSearch` regardless (skills =
  `TYPE_SKILLS.other` when the type is `other`).

## 5. Events (`lib/events.ts`)

One in-process `EventEmitter` (`globalThis` singleton, single-process assumption documented in the file header).
Typed helper `emit(name, payload)` / `on(name, handler)` / `off`. Event names and payloads:

| event | payload |
|---|---|
| `request:updated` | `{ request: HelpRequest }` |
| `dispatch:created` | `{ dispatch: Dispatch; request: HelpRequest }` |
| `dispatch:updated` | `{ dispatch: Dispatch; request: HelpRequest }` |
| `helper:updated` | `{ helper: Helper }` |

Emission rules:
- **The store never emits.** `lib/waves.ts` is the only emitter of `dispatch:*` and `request:updated`: `runWave`
  emits `dispatch:created` per new dispatch and then `request:updated`; `tick`, `onReject`, `accept` and `cancel` emit
  `dispatch:updated` for **every** dispatch whose status they change (pinged → accepted | rejected | expired | cancelled)
  and then `request:updated`; `escalate` emits `request:updated`. Every request status/wave/matchedHelperId change
  therefore produces exactly one `request:updated`.
- Every helper change (`POST`/`PATCH /api/helpers`, the rating's reliability update) emits `helper:updated`.
- `emit()` iterates the listeners itself and wraps each call (and any returned promise) in `try/catch`, logging
  `console.error("[events]", name, err)` and never rethrowing, so one broken subscriber can never block the others or
  throw into the emitting route. The emitter is created with `setMaxListeners(0)`.

## 6. HTTP API

Conventions: JSON bodies are read with `await req.text()` then `JSON.parse` inside `try/catch` (400 `{ error: "bad_json" }`);
handlers **never reject on `Content-Type`** (README §11 M1's curl sends none). Every handler validates by hand and every
non-2xx body is `{ error: string, ...extra }`: 400 `{ error: "bad_json" | "<field>_invalid" }`, 401 `{ error: "unauthenticated" }`,
403 `{ error: "forbidden" }`, 404 `{ error: "not_found" }`, 409 `{ error: <reason> }` (respond adds `ok: false, reason`),
429 `{ error: "too_many_requests", retryAfterSec: number }`, 502 `{ error: "sms_failed", detail: string }`,
500 `{ error: "internal" }`. Route files export `dynamic = "force-dynamic"`.
Route params: `{ params }: { params: Promise<{ id: string }> }` → `const { id } = await params`.

`lib/validate.ts` (M2) exports the guards every route uses: `isLatLng(x)` (object, finite numbers, lat ∈ [-90, 90],
lng ∈ [-180, 180]), `isUid(x)` (`/^[A-Za-z0-9_-]{8,64}$/`, used for `x-resq-uid` and `?uid=`), `text(x, max)` (string,
trimmed, 1..max chars, else null), `isStars(x)` (integer 1..5), `skillsOf(x)` (array of `isSkill`, deduped, 1..SKILLS.length,
else null). Inbound `HELP` text is capped at 1000 chars like `description`; longer bodies are truncated, not rejected.

Identities:
- **Requester**: header `x-resq-uid` (client-generated id kept in `localStorage["resq_uid"]`, see §6.1 `getUid`).
  EventSource cannot set headers, so the SSE route accepts `?uid=` instead.
- **Helper**: cookie `resq_session` = HMAC-signed `{ phone, helperId: string | null, exp }` (see §7).
  `getHelperSession(req)` requires `typeof payload.phone === "string"`; a helper token never verifies as ops.
- **Ops**: cookie `resq_ops` = HMAC-signed `{ ops: true, exp }` issued by `POST /api/ops/login`, **or** header
  `x-ops-password: <OPS_PASSWORD>` (used by scripts and tests). `isOps(req)` requires `payload.ops === true` from
  `resq_ops`, or a header whose SHA-256 equals SHA-256(`OPS_PASSWORD`) under `crypto.timingSafeEqual`. If
  `OPS_PASSWORD` is unset or empty the server uses `"resq-ops"` and `console.warn`s once (same pattern as
  `SESSION_SECRET`); it is never compared as `"" === ""`. Anything ops may do, ops may do on behalf of a helper by passing
  the helper `id` explicitly.
- `lib/auth.ts` exposes `getRequesterId(req)`, `getHelperSession(req)`, `isOps(req)` so routes stay short.

| Route | Auth | Body → Response |
|---|---|---|
| `GET /api/config` | none | `{ seedCenter: LatLng (getSeedCenter()), waveWindowMs, smsSimulated: boolean, ollamaModel }` |
| `POST /api/triage` | none | `{ text }` → `TriageResult` (200). **Preview only** (the M1 curl check); the requester page does not call it before creating a request. Fallback rules in §7 |
| `GET /api/triage` | none | health/warm-up: `{ ollama: "ok" \| "down", model, ms, modelPresent: boolean }` — checks `/api/tags` for the model, then one tiny generate with prompt `"ok"` and `keep_alive: "30m"` under its **own 60 s timeout** (never `OLLAMA_TIMEOUT_MS`). Called once on mount by `/` and `/ops` (fire-and-forget) and by `scripts/seed.ts` after seeding, so the model is resident before the first real request |
| `POST /api/requests` | requester | `{ description: string (1..1000 chars), location?: LatLng \| null }` → `RequestView` (201). Creates the row with `channel: "app"`, `requesterHelperId = getHelperSession(req)?.helperId ?? null`, `locationSource: "gps" \| "none"`; runs triage then `startSearch` (regardless of `clarifyingQuestion`) before responding; with `location: null` the row is returned already `escalated` (wave 0); with no candidates within 8 km it is returned already `escalated` (wave 4, see §4 empty-wave rule) |
| `GET /api/requests/:id` | requester (uid match) \| matched helper \| ops | `buildRequestView` |
| `PATCH /api/requests/:id` | requester (cancel/rate/resolve) \| matched helper (resolve) | `{ action: "cancel" }` \| `{ action: "resolve" }` \| `{ action: "rate", stars: 1..5 }` → `RequestView`. **cancel**: allowed from `triaging\|searching\|matched\|escalated` (409 `{ error: "conflict" }` otherwise) = `waves.cancel` (every `pinged` dispatch → `cancelled` with `dispatch:updated`, then `request:updated`). **resolve**: only from `matched` (409 otherwise) → `resolved`, `request:updated`. **rate**: only when status is `resolved` and `matchedHelperId` is set (409 otherwise); `saveRating` (re-rating allowed, last wins — no lookup needed), then helper `reliability = 0.8*old + 0.2*(stars/5)`: re-read the helper immediately before `upsertHelper` with no `await` in between and write only `reliability`; emit `helper:updated`. All three run inside the request lock |
| `POST /api/requests/:id/tick` | same as GET | no body → `RequestView & { advanced: boolean }` (`waves.tick`) |
| `GET /api/requests/:id/stream` | `?uid=` match \| ops cookie | SSE (see §6.1) |
| `POST /api/dispatches/:id/respond` | helper session (dispatch.helperId === session.helperId) \| ops | `{ action: "accept" }` → `waves.accept(id, "app")`: 200 `{ ok: true, request, dispatch, location: LatLng \| null, mapsUrl, requesterPhone }` (returned as-is) or 409 `{ ok: false, reason, error: reason }`; `{ action: "reject" }` → `waves.onReject(id, "app")`: 200 `{ ok: true, dispatch }` or 409 `{ ok: false, reason: "expired", error: "expired" }` when not `pinged`. Never calls `store.acceptDispatch` / `updateDispatch` directly |
| `POST /api/helpers` | helper session \| ops | `{ id?: string, name: 1..60, phone, skills: Skill[] (≥1, deduped), location?: LatLng \| null, onDuty?: boolean, reliability?: 0..1 (ops only), lastSeen?: ISO (ops only) }` → `{ helper }`. **With a helper session the record is keyed by `session.phone`** (body `phone` must normalise to it, else 403) and a body `id` is rejected with 403 unless it equals `session.helperId`; only ops may create/update by arbitrary `id` (the seed path) and set `reliability`/`lastSeen`. Upsert keeps every stored field absent from the body; a new helper gets `reliability: INITIAL_RELIABILITY`, `onDuty: false`, `location: null`, `lastSeen: now`; an existing helper keeps its stored `reliability` and `lastSeen` unless ops overrides. Emits `helper:updated`. Re-issues `resq_session` with `helperId` when called with a helper session |
| `PATCH /api/helpers` | helper session \| ops (+ `id` in body) | `{ id?, onDuty?: boolean, location?: LatLng }` → `{ helper }`; with a helper session `id` is ignored and `session.helperId` is used (401 if null, i.e. not registered yet); only ops may pass `id`. `setOnDuty` bumps `lastSeen`, emits `helper:updated`. **When `onDuty` becomes false**: after `setOnDuty`, run `waves.onReject(d.id)` for each `d` in `listPingedForHelper(id)`, so a wave whose remaining helpers all left advances immediately |
| `GET /api/helpers/me` | helper session | `buildHelperView(session.helperId)` (`helper` null when phone verified but not registered yet) |
| `GET /api/helpers/:id/stream` | helper session (id match) \| ops cookie | SSE (see §6.1) |
| `POST /api/auth/otp/send` | none | `{ phone }` → `{ ok: true, expiresInSec: 300, devCode?: string }`. Code = 6 digits from `crypto.randomInt(0, 1_000_000)` zero-padded, expires in 300 s, `saveOtp` then `sendSms(phone, tplOtp(code))`. The server **always** logs `[otp] phone=<phone> code=<code>` (laptop demo; the presenter's fallback). `devCode` is returned only when SMS is simulated. If `sendSms` resolves `{ ok: false }` → 502 `{ error: "sms_failed", detail }` and the code stays valid. 429 `{ error: "too_many_requests", retryAfterSec }` if a code was sent to that phone < 30 s ago |
| `POST /api/auth/otp/verify` | none | `{ phone, code }` → `verifyOtp`; on success sets `resq_session` = `{ phone, helperId: getHelperByPhone(phone)?.id ?? null, exp }` → `{ ok: true, helper: Helper \| null }`; 401 `{ error: "invalid_code" }` on bad/expired code (after the 5th wrong attempt the code is deleted, so further tries also get 401) |
| `POST /api/auth/logout` | none | **optional** — clears `resq_session` → `{ ok: true }` |
| `POST /api/ops/login` | none | `{ password }` → sets `resq_ops` cookie → `{ ok: true }`; 401 `{ error: "invalid_password" }` otherwise |
| `GET /api/ops/requests` | ops | before building the view, runs `waves.tick` for every `searching` request whose window has elapsed (idempotent, so curl/scripts see advanced state), then `buildOpsView` |
| `GET /api/ops/stream` | ops cookie | SSE: `snapshot` = `buildOpsView` on any event, coalesced (see §6.1) |
| `POST /api/twilio/inbound` | Twilio (form-encoded `From`, `Body`) \| ops (test injection) | TwiML `text/xml` reply (see §6.2). Signature check when `TWILIO_VALIDATE_SIGNATURE=1`, skipped for ops |

Phone numbers are normalised with `normalizePhone()` in `lib/sms.ts`: strip spaces/dashes/parentheses; `+` prefixed → keep;
10 digits → `+91` prefix; `0` + 10 digits → `+91`; anything else invalid (400). Both OTP routes, helper upsert and the
inbound webhook use it, so the same person always maps to the same helper.

### 6.1 SSE format (all three streams)

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`. On connect send `event: snapshot` immediately with the full current view (built by
`lib/views.ts`, same shape as the matching GET). Then, on every relevant emitted event, send another `event: snapshot`
with the full view — clients simply replace state; no diffing. Send a comment line `: ping` every 15 s.

Coalescing: per connection keep a `dirty` flag and **at most one snapshot build in flight** — an event sets `dirty`; if
no build is running, start one; when a build finishes and `dirty` is set, run again. Frames are therefore written in
build order (never a stale frame after a fresh one) and bursts (an accept emits N `dispatch:updated` + 1
`request:updated`) collapse into one frame. The ops stream uses the same mechanism plus a 500 ms minimum gap between
frames, trailing-edge (the last event always produces a frame).

Tear-down: `cleanup()` (`off` every listener, `clearInterval`, guarded `controller.close()`) is idempotent and is
triggered by any of: `request.signal` `"abort"`, the `ReadableStream` `cancel()` callback, or a thrown
`controller.enqueue` (every `enqueue` is wrapped in `try/catch`; a throw is treated as a disconnect). Handlers check a
`closed` flag before enqueueing.

Relevance filters: requester stream → events whose `request.id` matches; helper stream → `dispatch:*` where
`dispatch.helperId` matches (this is how a losing helper learns its card was cancelled/expired), `request:updated` where
`request.matchedHelperId` is the helper, `helper:updated` for that id; ops stream → everything.

Clients (`lib/client/sse.ts`): `useSnapshot<T>(streamUrl: string, pollUrl: string, init?: RequestInit): { data: T | null; connected: boolean; refresh(): void }`
opens an `EventSource`, parses `snapshot`, falls back to polling `pollUrl` (with `init`) every 5 s while disconnected,
and closes the `EventSource` and clears its timers in the effect cleanup (React StrictMode double-mounts in dev). Pairs:
requester `/api/requests/:id/stream?uid=<uid>` ↔ `/api/requests/:id` with header `x-resq-uid`; helper
`/api/helpers/:id/stream` ↔ `/api/helpers/me`; ops `/api/ops/stream` ↔ `/api/ops/requests`.
`getUid()` = `localStorage.resq_uid ??= (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""))`,
wrapped in `try/catch` (private mode; `randomUUID` is undefined on the insecure LAN-IP origin).

Who ticks (README §5: the requester's screen; ticks are idempotent so overlap is harmless):
- **Requester page**: while `status === "searching"` it runs a 1 s countdown from `waveEndsAt` (the latest snapshot;
  `waveWindowMs` from `/api/config` is only for the display before the first snapshot). Whenever
  `Date.now() >= Date.parse(waveEndsAt)` and no tick is in flight it POSTs `tick`, at most once per 2 s, until a
  snapshot shows a new `waveStartedAt` or a non-searching status. It also POSTs `tick` once on mount, on SSE reconnect,
  and immediately when a snapshot arrives whose `waveEndsAt` is already past. It never uses a fixed `waveWindowMs`
  interval (a fixed interval unaligned with `waveStartedAt` leaves the countdown at 0:00 for up to a full window).
- **`/ops` page**: every 5 s, POSTs `/api/requests/:id/tick` (ops cookie) for every request in its snapshot with
  `status === "searching"` and `waveEndsAt <= now`, at most once per request per 5 s. This is what advances SMS-in
  requests and abandoned app requests (no requester screen); still no server timers (README §5).

### 6.2 Twilio inbound (`app/api/twilio/inbound/route.ts`)

Parse the body with `await req.formData()` (Twilio posts `application/x-www-form-urlencoded`; never `req.json()`).
`From` → `normalizePhone`; `Body` → trim, collapse whitespace. Match `^(yes|no|help)\b` **case-insensitively at the
start** of the trimmed body (README §10 rule 10). No prefix stripping: the trial prefix exists only on outbound messages.
Order:
1. `^yes\b` → helper by `From` (none → reply "RESQ: This number is not registered. Open <PUBLIC_BASE_URL>/helper to
   join."); newest dispatch from `listPingedForHelper` (greatest `pingedAt`, ties by `id`; none → "RESQ: No open request
   for you right now.") → `waves.accept(dispatch.id, "sms")` (never `store.acceptDispatch` directly). Reply by result:
   `ok` → `tplHelperAccepted({ mapsUrl, phone })` ("RESQ: You're matched. Map: <mapsUrl>. Call the requester: <phone or
   'via app'>."); `already_matched` → "RESQ: Sorry, that request was already taken."; `expired` → "RESQ: Sorry, that
   request has expired."; `not_found` → "RESQ: No open request for you right now." (`accept` itself texts the requester
   when the request channel is sms.)
2. `^no\b` → helper by `From` (none → same "not registered" reply); newest pinged dispatch → `waves.onReject(id, "sms")`.
   Reply "RESQ: Skipped. Thank you." (also when nothing was pinged).
3. `^help\b(.*)` → text = rest, truncated to 1000 chars (must be ≥ 3 chars else reply "RESQ: Tell us what happened and
   where, e.g. HELP trapped near TKMCE hostel"). `matchLandmark(text)` → create HelpRequest `{ channel: "sms",
   requesterId: "sms:"+phone, requesterPhone: phone, requesterHelperId: (await store.getHelperByPhone(phone))?.id ?? null,
   location, locationSource: "landmark"|"none", landmark }`, triage, `startSearch` (or straight to escalated when no
   location). Reply "RESQ: Got it. Finding helpers near <landmark>. Call 112 if life is at risk." / "RESQ: Got it. We
   could not place you — a coordinator will call. Call 112 now if life is at risk."
4. Otherwise reply "RESQ: Reply YES or NO to a request, or HELP <what happened, where>."

Always return 200 `text/xml` built with `twiml(text)` from `lib/sms.ts`, which XML-escapes `& < > " '` before
inserting into `<?xml version="1.0" encoding="UTF-8"?><Response><Message>…</Message></Response>`; every reply,
including error replies, goes through it (a raw `&` in a URL makes Twilio drop the reply with error 12100).

Signature validation (when `TWILIO_VALIDATE_SIGNATURE=1`) uses `twilio.validateRequest(TWILIO_AUTH_TOKEN,
req.headers.get("x-twilio-signature") ?? "", PUBLIC_BASE_URL + "/api/twilio/inbound", formFieldsObject)`; 403
`{ error: "forbidden" }` on failure. **It is skipped for requests that carry a valid ops identity** (`isOps(req)`), so
the ops console and curl can inject test messages when there are no Twilio credentials (see §10 `/ops` and §11.1).

## 7. Sessions, SMS, triage, guidance, landmarks, seed

- `lib/session.ts`: `sign(payload: object): string` → `base64url(json) + "." + base64url(hmacSha256(SESSION_SECRET, json))`;
  `verify<T>(token): T | null`: split on `.`, base64url-decode, recompute the HMAC over the JSON bytes, compare with
  `crypto.timingSafeEqual` **only after an equal-length check**, then require `typeof exp === "number" && exp > Date.now()`
  (`exp` = Unix ms). If `SESSION_SECRET` is unset, generate `crypto.randomBytes(32).toString("hex")` once per process
  (stored on `globalThis.__resq_secret`) and `console.warn` that sessions will not survive a restart; never a fixed string.
  Cookie helpers `setSessionCookie(res, name, payload, maxAgeSec)`, `clearSessionCookie(res, name)`. All cookies:
  `path: "/"`, `httpOnly: true`, `sameSite: "lax"`, `secure: req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:"`
  (plain on `http://localhost` and the LAN fallback, secure behind the HTTPS tunnel). `resq_session` maxAge 7 days,
  `resq_ops` maxAge 12 h.
- `lib/sms.ts`: `smsConfigured()` (all three TWILIO vars set); `sendSms(to, body): Promise<{ ok: boolean; simulated: boolean; sid?: string; error?: string }>`
  never throws (logs); when not configured logs `[sms:simulated] to=<to> body=<body>` and resolves `simulated: true`;
  on a Twilio error resolves `ok: false, error: <twilio message>`. Lazy-loads the `twilio` SDK inside the function so
  the module is cheap to import. `twiml(text: string): string` (XML-escaped `<Response><Message>`, see §6.2).
  Templates — each **≤ 115 chars before the ~40-char trial prefix** (README §10 rule 10) so nothing splits into two segments:
  `tplPing({distanceKm, skill, type, urgency})` → "RESQ: person 400 m away needs a SWIMMER (flood, critical). Reply YES to accept, NO to skip. Expires in 30 s."
  where `skill` = first entry of `request.triage.skills` that the helper holds, else `triage.skills[0]`, rendered as
  `SKILL_LABELS[skill].toUpperCase()`; `type` rendered via `TYPE_SMS_LABELS[type]`; expiry text = `Math.round(WAVE_WINDOW_MS / 1000) + " s"`.
  `tplOtp(code)`, `tplRequesterMatched({name, skill, distanceKm, phone})`, `tplRequesterEscalated()`,
  `tplHelperAccepted({mapsUrl, phone})` (also the TwiML YES reply). `formatDistance(km)` → "400 m" / "1.2 km" (rounded to
  50 m / 0.1 km). `mapsUrl(loc)` → `https://maps.google.com/?q=<lat>,<lng>` (6-decimal fixed; no `&`, short enough for SMS).
- `lib/triage.ts`: `export async function triage(text: string): Promise<TriageResult>`. POSTs `${OLLAMA_URL}/api/generate`
  with `{ model: OLLAMA_MODEL, system, prompt: text, format: triageSchema(), stream: false, keep_alive: "30m", options: { temperature: 0, num_predict: 200 } }`
  under an `AbortController` (`OLLAMA_TIMEOUT_MS`, default 4000) and parses the `response` field. `triageSchema()` is a
  hand-written JSON-schema object literal (enums for `type`, `urgency` and `skills` items; all five keys required) —
  Ollama's structured-outputs form of README §4's `format: json`, which makes a 3B model's enum values reliable. If
  Ollama answers HTTP 400 to the schema (pre-0.5 server), retry once with `format: "json"` inside the same timeout
  budget. The schema is built from the taxonomy arrays, never typed by hand twice. The system prompt is ≤ 200 tokens built from the taxonomy lists (no examples) so prompt-eval
  fits the 4 s budget. Falls back to `triageByRules(text)` when: `fetch` throws (ECONNREFUSED etc. — what "unplugging
  Ollama" produces), non-2xx, abort, `JSON.parse(response)` fails, the guard fails, or `confidence < 0.5`. Guard
  `isTriageOutput(x)`: `type` must be a NeedType and `urgency` an Urgency (else fail); `skills` = known skills only
  (unknown dropped; empty → `TYPE_SKILLS[type]`); `confidence` clamped 0..1 (missing → 0.5); `summary` string ≤ 140 chars
  (missing → first 100 chars of the text). Ollama results carry `source: "ollama"`, `clarifyingQuestion: null`.
  `GET /api/triage` (warm-up) lives in the same file with its own 60 s timeout (§6).
- `lib/triage-rules.ts`: `export function triageByRules(text: string): TriageResult` — pure, sync, never throws.
  Normalise (lowercase, strip punctuation, collapse whitespace), then score every NeedType from a keyword table of
  `{ pattern: RegExp (word-boundary), weight }` entries — multi-word phrases weigh 3, single words 1–2; English plus
  common Malayalam/Manglish words (vellam, paambu/pambu, thee, current/shock, raktham/chora, kudungi, kaanunilla…).
  Highest score wins (ties → the more urgent type). Combination rule: when flood and mobility/vulnerability words both
  hit (can't walk, wheelchair, bedridden, paralysed, grandmother/grandfather/elderly/old, baby, pregnant, disabled,
  cannot move) → `evacuation_mobility` (README §3 example). Confidence: no hit → `type: "other"`, `urgency: "high"`,
  `confidence: 0.2`, `clarifyingQuestion: CLARIFYING_QUESTION`; only weak hits (total weight < 2) → 0.45 (question
  still set, dispatch still runs); total 2–3 → 0.6; ≥ 4 or any phrase hit → 0.8. Urgency: `critical` when a critical
  phrase hits (not breathing, unconscious, collapsed, no pulse, drowning, trapped, fire, heavy bleeding, chest pain,
  can't breathe, electrocuted, snake bite, unresponsive, water rising fast), else the type default
  (cardiac_no_breathing/fire/flood_rescue/trapped_structural/snakebite/electrical → critical; bleeding/
  evacuation_mobility/missing_person → high; fracture/supplies_oxygen_meds → medium; other → medium unless no hit).
  `skills: TYPE_SKILLS[type]`, `summary` = `TYPE_LABELS[type] + ": " + first ~80 chars`, `source: "rules"`. **Required classifications**: "father collapsed not breathing" →
  `cardiac_no_breathing`/`critical`; "flood water rising, grandmother can't walk, ground floor" →
  `evacuation_mobility`/`critical`; "trapped near TKMCE hostel" → `trapped_structural`/`critical`; plus `bleeding`,
  `fracture|broken`, `snake`, `shock|wire|electric`, `fire|smoke`, `missing`, `oxygen|medicine|insulin`,
  `drowning|flood` → the matching type. Optional `scripts/check-rules.ts` (node-runnable, no deps) asserts these and
  exits non-zero on failure.
- `lib/guidance.ts`: `GUIDANCE: Record<NeedType, GuidanceCard>` — 12 entries; the 11 README cards are the non-`other`
  types and `other` is a generic "stay safe, call 112" card (the `Record` needs all 12 keys and §5/§14 need a card for
  `other`). M1's "11 guidance cards present" is checked as `Object.keys(GUIDANCE).filter(t => t !== "other").length === 11`.
  3–6 short imperative steps each, `doNot` list, `call112When` list, `source` naming the Red Cross / WHO / St John
  material the wording follows. `getGuidance(type)`.
- `lib/landmarks.ts`: `LANDMARKS: { name: string; aliases: string[]; location: LatLng }[]` — ≥ 15 places around
  TKMCE / Kollam (campus gate, men's hostel, ladies hostel, Kadappakada, Chinnakada, Kollam Junction, KSRTC stand,
  Kollam beach, Ashtamudi, Kilikollur, Karicode, Kottiyam, Kavanad, Sakthikulangara, Thangassery…). Coordinates only
  need to be demo-plausible (within ~1 km). `matchLandmark(text): { name, location } | null`: normalise both sides
  (lowercase, strip punctuation/apostrophes, collapse whitespace); an alias must appear as a whole word/phrase (`\b`
  boundaries); **longest alias wins**, ties → first in the table. Mandatory aliases: men's hostel → `["tkmce hostel",
  "hostel", "mens hostel", "men's hostel", "boys hostel"]`; ladies hostel → `["ladies hostel", "womens hostel", "girls hostel"]`;
  campus gate → `["tkmce", "tkm college", "college", "campus", "college gate"]`; plus `kadappakada`, `chinnakada`,
  `kollam junction`, `railway station`, `ksrtc`, `beach`. `matchLandmark("trapped near TKMCE hostel")` must return the
  men's hostel ("tkmce hostel" beats "hostel" and "tkmce"); keep this exact example as a comment-level test in the file.
- `scripts/seed.ts`: **self-contained** (imports only `node:` builtins and `import type` from `../lib/types`), because
  Node runs it directly with type stripping (`npm run seed` = `node scripts/seed.ts`). Erasable syntax only: no `enum`,
  `namespace`, parameter properties, decorators, `import x = require`; `import type` for types and no relative value
  imports (the skill list is duplicated as a `Skill[]` literal in the seed). Exports
  `seedHelpers(center: LatLng, now: Date): Helper[]` — 30 deterministic helpers (fixed-seed PRNG, e.g. mulberry32):
  ids `seed-helper-01..30`, Kerala names, phones `+9190000000` + two digits, 1–3 skills each with every skill
  represented at least twice and doctors/nurses/swimmers/boat owners ≥ 3 each, positions 10 within 0.15–1 km, 10 within
  1–2 km, 10 within 2–5 km of `center`, all `onDuty: true`. **Demo constraints (M6, §13 step 4)**: `reliability` 0.5–0.65,
  `lastSeen = now − 15 min` (recency 0.5), **no seeded helper within 150 m of `center`**, and **no seeded helper holds
  every skill of `TYPE_SKILLS.evacuation_mobility` or of `TYPE_SKILLS.flood_rescue`** (skillMatch ≤ ⅔ for the demo
  scenario whichever of the two types triage returns). Seeded maximum is then 0.45·⅔ + 0.30·1 + 0.15·0.65 + 0.10·0.5 = 0.7475;
  a demo helper registered with `swimmer, boat_owner, driver_4x4, first_aid` (skillMatch 1 for both types),
  reliability 0.7 and recency 1 scores 0.955 at the requester's location and stays above 0.7475 up to ~690 m away, so
  both demo phones are in wave 1's top 3 whenever they are within ~600 m of the request. When run as a script
  (`process.argv[1]` ends with `scripts/seed.ts`): reads `.env.local` from `process.cwd()` by hand (no dotenv; one
  `KEY=VALUE` per line, `#` starts a comment, surrounding quotes stripped, values trimmed, missing file is not an error)
  for `OPS_PASSWORD` and `SEED_CENTER_*` (default `SEED_CENTER_DEFAULT`), then `POST`s each helper (including
  `reliability` and `lastSeen`) to `${RESQ_URL ?? "http://127.0.0.1:3000"}/api/helpers` with `x-ops-password`, then
  calls `GET /api/triage` once and prints its result, printing a one-line summary. If the server is unreachable it
  prints `seed: server not reachable at <url>; MemoryStore seeds itself at boot (SEED_ON_BOOT=1)` and **exits 0** (README
  §12 runs `npm run seed && npm run dev` before the server is up). `MemoryStore` also calls `seedHelpers()` in its
  constructor unless `SEED_ON_BOOT=0`, so the demo works even if nobody runs the script.

## 8. Process model (Next dev + HMR)

Every server singleton (store, event emitter, OTP rate-limit map, SSE client counters, per-request lock map
`__resq_locks`, generated session secret `__resq_secret`) must live on `globalThis` under a `__resq_*` key so Turbopack
module re-evaluation in `next dev` does not reset state:
`const g = globalThis as unknown as { __resq_store?: Store }; export function getStore() { return (g.__resq_store ??= createStore()); }`.
Any interval a module installs is created with `??=` and `unref()` so a re-evaluation never installs a second one
(today only the SSE `: ping` intervals exist, per connection; there is no server-side wave timer — README §5).

`next.config.ts` (M0) must contain
`allowedDevOrigins: ["*.trycloudflare.com", ...(process.env.RESQ_DEV_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)]`.
Entries are hostnames only (no scheme/port); `*` matches exactly one DNS label. Without this, `next dev` blocks
`/_next/*` for every phone on the tunnel or the LAN IP (blank page, no geolocation, no Hold-to-speak). The check is
dev-only; `next build && next start` does not need it.

## 9. Environment variables (`.env.example` must list all of these with comments, one variable per line)

```
TWILIO_ACCOUNT_SID=            # leave blank to run in simulated-SMS mode (codes/pings printed to the server log)
TWILIO_AUTH_TOKEN=
TWILIO_FROM=+1...
TWILIO_VALIDATE_SIGNATURE=0    # 1 to verify X-Twilio-Signature on the inbound webhook (needs PUBLIC_BASE_URL); ops identity bypasses it
OLLAMA_URL=http://127.0.0.1:11434   # loopback IP, not "localhost": Ollama binds 127.0.0.1 and an IPv6-first resolve wastes part of the 4 s budget
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_TIMEOUT_MS=4000
SESSION_SECRET=                # openssl rand -hex 32 (blank = random per process, sessions die on restart)
OPS_PASSWORD=resq-ops
SEED_CENTER_LAT=8.913          # set to the venue's real coordinates before `npm run seed` (see §11.2)
SEED_CENTER_LNG=76.635
SEED_ON_BOOT=1
STORE=memory
PUBLIC_BASE_URL=               # https://<cloudflared>.trycloudflare.com — used in SMS links and signature checks
RESQ_WAVE_WINDOW_MS=30000
RESQ_DEV_ORIGINS=              # comma-separated extra dev hostnames for allowedDevOrigins, e.g. 192.168.1.20 for the LAN fallback
```

## 10. UI contracts (for M3/M5)

- `app/layout.tsx`: `<html lang="en">`, viewport export, body `min-h-dvh`, light/dark via Tailwind `dark:` (media
  strategy = `prefers-color-scheme`, the v4 default). A fixed bottom-right **Call 112** (`<a href="tel:112">`) pill
  ≥ 48 px on every page.
- `/` requester: single column, textarea + **Hold to speak** (Web Speech API when available, else hidden) + big
  **Get help** button; calls `GET /api/triage` once on mount (fire-and-forget warm-up); after submit: triage chip
  (type label, urgency colour), guidance card (static text), countdown "Pinging N helpers within R km… 0:27" driven by
  `waveEndsAt` (tick rules in §6.1), then matched card (name, skill, distance, `tel:` link), rate 1–5 after resolve.
  `triage.clarifyingQuestion` is shown as a banner above the guidance card; the textarea stays editable and a second
  **Get help** creates a new request (there is no update route). `status === "escalated"` → replace the countdown with a
  red card "No helper could be reached. Call 112 now." containing a ≥ 48 px `<a href="tel:112">` button and a **Try
  again** button that creates a new request; `status === "cancelled"` → "Request cancelled". Location:
  `navigator.geolocation` → else `/api/config` seed centre with a visible "using demo location" note.
- `/helper`: phone → OTP (shows `devCode` hint when simulated; on a 502 `sms_failed` shows "SMS failed — ask the
  presenter for the code" and still offers the code input) → profile form (name, skills checkboxes ≥ 48 px) → duty
  toggle (shares location every 60 s while on) → incoming card(s) with Accept/Reject and a live countdown (a card is
  hidden client-side once its `expiresAt` passes; server rows are left to `tick`) → active job card (maps link, requester
  phone or "Contact: via app" when `requesterPhone` is null, **Done** button = `PATCH { action: "resolve" }`).
- `/ops`: password form → dashboard: calls `GET /api/triage` once on mount; inline SVG map (equirectangular around seed
  centre, rings 1/2/4/8 km, helpers as dots coloured by first skill, requests as pulsing markers coloured by status),
  lists: open, escalated (flagged **SMS-in** / **No location** badges, dispatch `channel` badge), coverage by skill
  (count of on-duty helpers per skill); the 5 s tick loop from §6.1; and a collapsible **Simulate inbound SMS** panel
  (From = E.164, Body = text) that POSTs `application/x-www-form-urlencoded` to `/api/twilio/inbound` with `fetch` (the
  ops cookie is sent) and shows the returned TwiML text — always rendered for ops, expanded by default when
  `smsSimulated`.

## 11. Milestone → file ownership

| Milestone | Files |
|---|---|
| M0 | package.json, tsconfig.json, next.config.ts (incl. `allowedDevOrigins`, §8), postcss.config.mjs, .gitignore, .env.example, app/layout.tsx, app/globals.css, three placeholder pages, lib/types.ts, lib/taxonomy.ts, lib/events.ts, docs/CONTRACTS.md |
| M1 | lib/guidance.ts, lib/landmarks.ts, lib/triage-rules.ts, lib/triage.ts, app/api/triage/route.ts, app/api/config/route.ts, optional scripts/check-rules.ts |
| M2 | lib/dispatch.ts, lib/waves.ts, lib/views.ts, lib/validate.ts, lib/store/index.ts, lib/store/memory.ts, scripts/seed.ts, lib/session.ts, lib/auth.ts, lib/sms.ts (templates + simulated send + twiml), app/api/requests/**, app/api/dispatches/**, app/api/helpers/route.ts, app/api/helpers/me/route.ts, app/api/auth/**, app/api/ops/login, app/api/ops/requests |
| M3 | the three SSE routes, lib/client/sse.ts, functional requester + helper pages |
| M4 | real Twilio send in lib/sms.ts, app/api/twilio/inbound/route.ts, OTP over SMS verified |
| M5 | final UI for all three pages, SVG map, Lighthouse |
| M6 | seed script end-to-end, demo run-through, docs |

### 11.1 Acceptance commands (README §11, made literal)

```bash
# M1 — exactly as README (no Content-Type header; handlers must accept it)
curl -X POST localhost:3000/api/triage -d '{"text":"father collapsed not breathing"}'
# M2 — create (needs x-resq-uid and a location; without location the row is escalated at wave 0)
curl -X POST localhost:3000/api/requests -H 'x-resq-uid: test-0001' \
  -d '{"description":"flood water rising, grandmother cannot walk","location":{"lat":8.913,"lng":76.635}}'
# M2 — wave advance: wait WAVE_WINDOW_MS then
curl -X POST localhost:3000/api/requests/<id>/tick -H 'x-resq-uid: test-0001'      # → advanced: true, wave 2, radiusKm 2
# M2 — concurrent accept: two dispatch ids of one request, exactly one ok: true
curl -X POST localhost:3000/api/dispatches/<d1>/respond -H 'x-ops-password: resq-ops' -d '{"action":"accept"}' &
curl -X POST localhost:3000/api/dispatches/<d2>/respond -H 'x-ops-password: resq-ops' -d '{"action":"accept"}' & wait
# M2 — "4 empty waves → escalated": a location with no seeded helper within 8 km; the create response is already escalated, wave 4
curl -X POST localhost:3000/api/requests -H 'x-resq-uid: test-0002' \
  -d '{"description":"test","location":{"lat":9.9,"lng":76.3}}'
# M4 — inbound without Twilio (ops identity bypasses the signature check)
curl -X POST localhost:3000/api/twilio/inbound -H 'x-ops-password: resq-ops' \
  --data-urlencode 'From=+919000000001' --data-urlencode 'Body=HELP trapped near TKMCE hostel'
```

### 11.2 Demo-night checklist (extends README §12)

1. Twilio console: enable India in Messaging Geo-Permissions; verify every demo phone; send one test OTP and one
   inbound YES from each demo SIM at hour 0 (international SMS must be enabled on the SIM).
2. After every `cloudflared` restart: update the Twilio inbound webhook, `PUBLIC_BASE_URL`, and (if the hostname is not
   `*.trycloudflare.com`) `RESQ_DEV_ORIGINS`; restart `next dev`.
3. Set `SEED_CENTER_*` to the venue's real coordinates (read them from a phone) before `npm run seed`, so seeded
   helpers, the requester's "demo location" fallback and the real phones' GPS agree.
4. Demo helper phones register with **all** of `swimmer`, `boat_owner`, `driver_4x4`, `first_aid` and toggle on duty
   from the tunnel URL so GPS is real; both must be within ~600 m of the requester phone (§7 seed guarantee).
5. Keep the `/ops` **Simulate inbound SMS** panel and the `[otp]` server log as the fallback for §13 steps 1, 4 and 6
   if Twilio misbehaves.
6. Set `RESQ_WAVE_WINDOW_MS=15000` for the rehearsal if 30 s waves feel slow; `/api/config` propagates it to the countdown.

## 12. Decisions log

Findings are named `<lens>/<severity>: <topic>`; the three lenses are spec, state and demo.

### Applied

- spec/must: dispatch:updated never emitted + accept side-effects split → §4 gained `accept(dispatchId, via)` and §5 an emission rule (every dispatch status change emits `dispatch:updated`, every request change `request:updated`, every helper change `helper:updated`); §6 respond row and §6.2 now call `waves.accept`/`waves.onReject` only.
- spec/must: onReject vs README §13 step 4, demo phones not guaranteed in wave 1 → §4 "a single reject never back-fills" note + pitch-owner reword; §7 seed constraints (no all-skills seed, none within 150 m, reliability 0.5–0.65, lastSeen −15 min) with the numeric guarantee; §11.2 item 4.
- spec/must: two-tier skill-first ranking → §4 `selectWave` ranking is now pure `score` desc, `distanceKm` asc, `id` asc; "one deliberate refinement" deleted.
- spec/should: OpsView needed resolved/cancelled rows → §2 `buildOpsView` = `listOpenRequests()` exactly (README §9).
- spec/should: triage functions/Ollama body/fallback triggers/guard/rules undefined → §7 `lib/triage.ts` + `lib/triage-rules.ts` paragraphs (`/api/generate`, `format: "json"`, keep_alive, ECONNREFUSED in the fallback list, guard leniency, rules confidences, required classifications; "trapped near TKMCE hostel" → critical, no-hit → other/high/0.2).
- spec/should: warm-up shares the 4 s abort, nobody calls it → §6 `GET /api/triage` own 60 s timeout, called by `/`, `/ops` on mount and by the seed script (§7, §10).
- spec/should: clarifyingQuestion semantics → §2, §4, §6, §10: never blocks dispatch, banner on `/`, `POST /api/triage` is preview-only.
- spec/should: no escalated/cancelled state on `/` → §10 red "Call 112 now" card + Try again, "Request cancelled".
- spec/should + state/must + demo/should: fixed 30 s client tick unaligned with waveStartedAt → §6.1 requester ticks from a 1 s countdown when `now >= waveEndsAt` (once per 2 s, once on mount/reconnect/past snapshot); §4 `tick` uses `TICK_GRACE_MS` (1 s); §1 constant added.
- spec/should + demo/should: SMS-in and abandoned requests never tick → §6.1 `/ops` page ticks due searching requests every 5 s; §6 `GET /api/ops/requests` runs `tick` on due requests before building the view.
- spec/should + state/must: no serialisation of tick/onReject/runWave/accept → §4 "Locking" paragraph (`withRequestLock` on `globalThis.__resq_locks`, re-read inside the lock, `runWave` no-op when not searching, writes before emits); idempotence sentence replaced.
- spec/should + state/should: PATCH /api/requests/:id undefined → §6 row now states allowed source statuses, cancel via `waves.cancel` (pinged → cancelled with events), resolve only from matched, rate only when resolved+matched, reliability update, `helper:updated`, all under the lock; §4 `cancel`.
- spec/should: tplPing skill/type/expiry undefined → §7 skill selection rule, `TYPE_SMS_LABELS` (§1), expiry from `WAVE_WINDOW_MS`.
- spec/should: Dispatch.channel comment self-contradictory → §2 comment rewritten (created "app", webhook sets "sms" via `accept`/`onReject`, badge on /ops).
- spec/should + state/should: HelperView.active/pinged derivation → §2 `buildHelperView` (active = newest matched request for the helper; pinged newest first, excludes non-searching requests); §10 hides expired cards client-side.
- spec/should: useSnapshot GET not derivable → §6.1 `useSnapshot(streamUrl, pollUrl, init?)` with the three pairs.
- spec/should + demo/must: landmark aliases/matching undefined → §7 normalisation, whole-word matching, longest wins, mandatory aliases, the "trapped near TKMCE hostel" example as an in-file test.
- spec/should: seed script exits non-zero before the server is up; POST /api/helpers upsert semantics → §7 exit 0 with message; §6 POST row keeps stored fields, defaults for new helpers, ops-only `reliability`/`lastSeen`.
- spec/should: OTP length/OPS_PASSWORD-unset undefined → §6 send row (6 digits via `crypto.randomInt`, 300 s, `[otp]` log always); §6 Identities (`OPS_PASSWORD` unset/empty → `"resq-ops"` + warn, hashed constant-time compare).
- spec/should: inconsistent error bodies → §6 conventions (`{ error, ...extra }` for every non-2xx; respond 409 adds `ok:false, reason`; verify 401 `invalid_code`; send 429 with `retryAfterSec`).
- spec/should + state/nice: empty-wave rule wording hides the M2 consequence → §4 reworded (create response already `escalated`, wave 4, zero dispatches; verified on the create response) + docs-owner note for README §10 rule 5.
- spec/should: acceptance commands missing / Content-Type → §6 conventions (`req.text()` + `JSON.parse`, never reject on Content-Type) and new §11.1 with the literal curl commands.
- spec/nice: 12 vs 11 guidance cards → §7 M1 check expression.
- spec/nice: deviations catalogue → compact "Deviations from README" list in the intro; `POST /api/auth/logout` marked optional.
- spec/nice: garbled inbound matching sentence, unregistered `From` → §6.2 `^(yes|no|help)\b` rule, no prefix stripping, "not registered" reply.
- spec/nice + demo/nice: cookie exp units/lifetimes/secure flag → §7 (`exp` Unix ms, 7 d / 12 h, `path: "/"`, `secure` only when `x-forwarded-proto` is https).
- spec/nice: small undefined values → §2 `HelperPublic.distanceKm`, §4 `selectWave` returns `[]` on null location/triage, §1 `SEED_CENTER_DEFAULT`/`getSeedCenter`, §10 "Contact: via app".
- state/must: emissions centralised → §4/§5 as above; `accept` returns the store result shape plus `location`, `mapsUrl`, `requesterPhone`.
- state/should + demo/must: SSE listener throws / max-listeners / no cleanup → §5 `emit` try/catch + `setMaxListeners(0)`; §6.1 idempotent `cleanup()` on abort, stream cancel and thrown enqueue; `useSnapshot` effect cleanup.
- state/should: requester's own helper record unlinked → §2 `HelpRequest.requesterHelperId` set by `POST /api/requests` (session cookie) and the HELP path (`getHelperByPhone`); §4 `excludeHelperIds` definition.
- state/should: MemoryStore reference ownership → §3 `structuredClone` on every read/write; in-place mutation never persisted.
- state/should: loser of the accept race gets `expired` → §3 step 2 (`cancelled` → `already_matched`), §6.2 adds the `expired` reply.
- state/should: tick "of this wave", null waveStartedAt, onReject checks → §4 `tick` expires pinged dispatches of any wave, treats `waveStartedAt === null` as elapsed; `onReject` re-reads, 409 when not pinged, stops when the request is not searching or the wave differs.
- state/should: out-of-order/dropped SSE frames → §6.1 dirty-flag/one-build-in-flight coalescing; ops 500 ms trailing-edge.
- state/should: going off duty while pinged → §6 PATCH /api/helpers runs `waves.onReject` for each pinged dispatch.
- state/nice: waveEndsAt on non-searching views, "newest dispatch" ordering → §2 `waveEndsAt` null unless searching; §2/§6.2 newest = greatest `pingedAt`, ties by `id`.
- state/nice: rating clobbers concurrent helper writes → §6 rate re-reads the helper right before `upsertHelper` and writes only `reliability`.
- state/nice: §8 singleton list → §8 adds `__resq_locks`, `__resq_secret`, `??=` + `unref()` rule.
- demo/must: `allowedDevOrigins` missing → §8 `next.config.ts` requirement, §9 `RESQ_DEV_ORIGINS`, §11.2 item 2, §11 M0 row.
- demo/must: raw `&` in TwiML, body parsing → §6.2 `req.formData()`, `twiml()` XML-escaping for every reply; §7 `mapsUrl` = `https://maps.google.com/?q=lat,lng`.
- demo/must: backfill on reject → resolved via the finding's own alternative: strict reading kept, §7 seed guarantee and §4/§11.2 demo notes added; the backfill mechanism itself was not adopted because README §5 ("ping top 3" per wave) and §10 rule 5 ("the only immediate transition") forbid pinging a 4th helper mid-wave.
- demo/must: seeded phantoms outrank demo phones; seed cannot set reliability/lastSeen → §7 seed constraints (reliability 0.5–0.65, lastSeen −15 min, skill and distance constraints, numeric guarantee); §6 POST /api/helpers ops-only `reliability`/`lastSeen`; §11.2 item 4.
- demo/should: waves exports accept/reject/cancel → §4 (routes only validate identity and call these).
- demo/should: two implementations of each view → §2 `lib/views.ts` builders; §11 M2 row.
- demo/should: no way to run §13 steps 4/6 without Twilio → §6.2 signature check bypassed for ops identity + `twilio.validateRequest` details; §10 `/ops` Simulate inbound SMS panel; §11.1 curl.
- demo/should: Ollama call shape/keep_alive/warm-up callers → §7 (`keep_alive: "30m"`, `num_predict: 200`, ≤ 200-token system prompt), §6 warm-up 60 s and callers.
- demo/should: OTP send hides Twilio failure; no attempt limit → §6 send 502 `sms_failed` (code stays valid) + `[otp]` log; §2 `Otp.attempts`, §3 `verifyOtp` deletes the code on the 5th wrong attempt; §10 helper page copy.
- demo/should: fixed dev secret, verify details, isOps edge cases → §7 random per-process secret on `globalThis.__resq_secret`, equal-length check before `timingSafeEqual`, `exp` check; §6 Identities (`getHelperSession` phone check, hashed ops compare, helper token never verifies as ops).
- demo/should: helper session can overwrite another helper by `id` → §6 POST keyed by `session.phone`, body `id` 403 unless own; PATCH ignores `id` for helper sessions.
- demo/should: missing input validation, `randomUUID` on insecure origins → §6 `lib/validate.ts` guards, HELP text cap; §6.1 `getUid()` fallback; §11 M2 row.
- demo/should: rules must classify the demo phrases → §7 required classifications (merged with spec/should), optional `scripts/check-rules.ts` in §11 M1.
- demo/nice: seed erasable-syntax and `.env.local` parsing rules → §7; §9 "one variable per line".
- demo/nice: templates vs trial prefix → §7 templates ≤ 115 chars, short maps URL, `formatDistance` rounding.
- demo/nice: `OLLAMA_URL` loopback → §9 `127.0.0.1`; §7 seed default `http://127.0.0.1:3000`.
- demo/nice: demo-night checklist → §11.2.

### Deferred

- state/should: server-side sweeper `setInterval` in `lib/waves.ts` → contradicts README §5 ("It is idempotent, so no long-running timers are needed") and §10 rule 5 ("Waves are tick-driven"); its stated fallback (ops GET + `/ops` page ticking) was applied instead.
- state/should (part): 409 `already_rated` on a second rating → needs a Store lookup README §9 does not have; re-rating is allowed with last-wins instead (spec/should proposal), the double reliability update being negligible for a demo.
- demo/should (part): `POST /api/chat` with a JSON-schema `format` → `/api/chat` not adopted. **Orchestrator override (2026-09-19):** `/api/generate` keeps the endpoint, but `format` IS the JSON-schema object (Ollama structured outputs, a superset of README §4's `format: json`) with a one-shot retry on `format: "json"` if the server answers 400 — enum-valid output from a 3B model matters more than the smaller diff. §7 updated.
- spec/should (part): rules "first hit wins" → **Orchestrator override:** weighted keyword scoring with the confidence tiers in §7 (same observable outputs: type, urgency, confidence, clarifyingQuestion; the required classifications are unchanged).
- demo/must (part): backfill of a rejected slot mid-wave → see the Applied entry; not adopted because README §5/§10 rule 5 forbid it.
- spec/should (part): return `devCode` when `sendSms` fails with Twilio configured → over a public tunnel this would let anyone log in as any unverified number; replaced by the demo/should 502 + `[otp]` server-log path.
- demo/should (part): 429 `too_many_attempts` from `POST /api/auth/otp/verify` → would need `verifyOtp` to return more than the README §9 boolean; a burned code simply returns 401 like any other bad code.
- demo/should (part): `OPS_PASSWORD` unset → 503 `ops_disabled` → `.env.example` already ships `OPS_PASSWORD=resq-ops` and README §12 is the only documented setup path, so the spec/should default-plus-warning was chosen; the `"" === ""` hole is closed by the hashed compare and the non-empty default.
- spec/nice (part): mark `listHelpers` optional → an optional interface method would make `OpsView.helpers` ambiguous; kept required (one line in MemoryStore, README §3 "helper coverage by skill").
- demo/should (part): `scripts/check-rules.ts` as a required file → listed as optional in §11 M1 to avoid widening M1's scope; the required classifications themselves are contractual.
