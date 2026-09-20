# Sahaya upgrade — six features, mapped onto the existing code

The product spec speaks of `Incident`, `Volunteer` and `lib/store.ts`. In this codebase those are **`HelpRequest`**,
**`Helper`** and **`lib/store/` (`getStore()`)**. Everything below uses the real names.

**Already in place (the foundation, do not change):** `lib/types.ts` (new fields and types), `lib/policy.ts`
(fees, categories, tiers, accessors, `fallbackMs()`), `lib/hazards.ts` (curated hazard table), `components/TrustBadge.tsx`,
`/api/config` (adds `fallbackMs`, `currency`, `calloutFees`).

Records written before the upgrade lack the new fields: **always read them through the accessors** in `lib/policy.ts`
(`categoryOf`, `feeOf`, `tierOf`, `walletOf`, `canAccept`).

---

## 1. Monetization: urgency pricing and escrow

- `HelpRequest.category`: `LIFE_SAFETY` (default, always free) or `HOUSEHOLD_MICROGIG`.
- A micro-gig needs `gigType` (`plumbing | electrical | generator_power | other_repair`) and `calloutFee` ∈ `CALLOUT_FEES`
  (₹200 / ₹500 / ₹1000; `CURRENCY` and the list live in `lib/policy.ts`). `escrowStatus` = `"HELD"` on creation.
  Life-safety requests have `calloutFee: 0`, `escrowStatus: null`.
- **Safety override:** after triage, if `mustBeLifeSafety(triage, description)` the request is converted to
  `LIFE_SAFETY`, fee 0, `escrowStatus: "REFUNDED"`, `upgradedToLifeSafety: true`. Nobody pays for an emergency.
- A micro-gig that stays a micro-gig: `triage.skills = GIG_TYPES[gigType].skills`, `triage.equipment` ∪= `GIG_TYPES[gigType].equipment`,
  urgency capped at `"medium"`.
- **Payout:** `waves.resolve()` releases escrow in the same locked transition (credit `helper.walletBalance`, set
  `escrowStatus: "RELEASED"`, emit `helper:updated` + `request:updated`). `waves.cancel()` sets a `HELD` escrow to `REFUNDED`.
- `POST /api/incident/payout` `{ requestId }` — requester, matched helper or ops. Idempotent:
  200 `{ ok: true, escrowStatus: "RELEASED", amount, helperId, walletBalance, alreadyReleased }`;
  409 `{ error: "not_resolved" | "not_microgig" | "no_helper" | "refunded" }`; 404 `not_found`. Implemented by
  `waves.payout(requestId)` → `withRequestLock` → `releaseEscrowLocked()` in `lib/escrow.ts` (the lock is **not** re-entrant:
  `resolve()` calls `releaseEscrowLocked` directly, never `payout`). A double call must never credit twice.
- `POST /api/requests` body adds `category?`, `gigType?`, `calloutFee?`; 400 `category_invalid | gigType_invalid | calloutFee_invalid`.
  A micro-gig requires a signed-in account (401 otherwise). The response is still `RequestView`.

## 2. AI hazard detection

- `TriageResult.hazardAlert: { hasHazard, kind, hazardTitle, hazardAction }` and `TriageResult.equipment: Equipment[]`.
- The Ollama system prompt is expanded to look for **hidden environmental hazards**, and the JSON schema forces a
  `hazardAlert` object `{ hasHazard: boolean, hazardKind: <HAZARD_KINDS>, hazardTitle: string, hazardAction: string }`.
- **Safety rule (non-negotiable, README §10 rule 9):** the text shown to the user is never the model's. The server keeps
  only `hasHazard` + `hazardKind` and builds the alert with `hazardAlertFor(kind)` from `lib/hazards.ts`. `hasHazard: true`
  with an unknown kind → `"other"`. Keyword rules (`detectHazardByRules(text)`) run on every request; when they fire
  they win over the model (deterministic), otherwise the model's kind is used. The HTTP response still has exactly the
  `{ hasHazard, hazardTitle, hazardAction }` fields the spec asks for (plus `kind`).
- Latency budget: warm `qwen2.5:3b` must answer the demo phrases inside the 4 s timeout. If the extra title/action
  tokens break that, drop those two properties from the schema (keep `hasHazard` + `hazardKind`) and say so in the report.
- Demo phrases and expected hazards: "Basement flooded, need pump" → `electrocution`; "smell of gas in the kitchen" →
  `gas_leak`; "house flooded, water rising fast outside" → `fast_water` or `electrocution`; "my father collapsed, not breathing" → none.
- UI: a pulsing amber/red **Hazard Warning Banner** at the very top of the requester's live screen (`role="alert"`).

## 3. Trust tiers

- `Helper.trustTier`: `TIER_1_NEIGHBOR` (default) · `TIER_2_CERTIFIED_PRO` · `TIER_3_FIRST_RESPONDER`; `credentialId` is
  required (3–40 chars) when claiming tier 2 or 3 (`POST /api/helpers` → 400 `credentialId_invalid`, `trustTier_invalid`).
  Tiers are self-declared in the demo; the UI says so.
- Dispatch: `LIFE_SAFETY` + urgency `critical` → **wave 1** ranks Tier-3 helpers first (then by score). Micro-gigs only
  ping helpers with a matching skill **and** `TIER_2_CERTIFIED_PRO`.
- Accepting (`waves.accept`, `waves.claim`, SMS `YES`): `!canAccept(helper, request)` → `{ ok: false, reason: "tier_required" }`
  → HTTP 403 `{ ok: false, reason: "tier_required", error: "tier_required", requiredTier: "TIER_2_CERTIFIED_PRO" }`.
- The feed (`lib/feed.ts`) hides micro-gigs from users who cannot accept them.
- `DispatchPublic.helperTier` and `HelperPublic.trustTier` are already populated by `lib/views.ts`. Badges: `<TrustBadge tier />`.
- Seeded helpers: electrician/plumber/generator_owner → Tier 2; others Tier 1. (The doctor/nurse → Tier 3
  rule still exists in seedTier() but no seeded provider hits it: the seed is trades-only since
  doctor/nurse/caregiver stopped being bookable services.)
  (`scripts/seed.ts` stays self-contained: `import type` only). `npm run seed` must push tiers to a running server.

## 4. Hands-free voice

- Ask-for-help screen: a **pulsing microphone button next to the text box**. Tap once to start
  (`window.webkitSpeechRecognition` / `SpeechRecognition`), live transcript fills the box, recognition stops by itself on
  silence. The **final transcript is sent straight to `POST /api/triage`** (no typing, no extra tap): show the result
  (type, urgency, hazard banner, equipment) and auto-send the request after a 3 s cancellable countdown.
- Unsupported browsers: hide the button; typing still works.

## 5. Skills + equipment matching

- `TriageResult.equipment` = equipment the situation calls for (model enum ∪ keyword rules: pump → `water_pump`,
  ladder → `rope_ladder`, oxygen → `oxygen_cylinder`, stretcher/wheelchair, life jacket, chainsaw/cutter/fallen tree,
  torch/power bank, extinguisher, car/vehicle/transport, first-aid kit). Max 4.
- `selectWave` checks **both** `helper.skills` and `helper.equipment`:
  `capabilityMatch = (|neededSkills ∩ skills| + |neededEquipment ∩ equipment|) / (|neededSkills| + |neededEquipment|)`
  replaces `skillMatch` in the README §5 formula (weights unchanged). Eligible = `capabilityMatch > 0`. For `LIFE_SAFETY`,
  if fewer than 3 eligible helpers are in radius, fill with the nearest others (a bystander beats nobody). Micro-gigs are strict.
- New `selectWave` inputs are optional so existing callers and tests keep working.

## 6. 3-minute smart fallback (LIFE_SAFETY only)

- `tick()`: a `searching` life-safety request older than `fallbackMs()` (180 s; `RESQ_FALLBACK_MS` overrides) escalates at
  once, even mid-wave. All 4 waves finishing still escalates as before. `tickDueRequests()` honours the deadline too.
- On escalation of a life-safety request: set `fallbackAt`; text the requester's `requesterProfile.emergencyContactPhone`
  once (`emergencyContactNotifiedAt`): "RESQ: <name> asked for emergency help (<type>) and no local helper has responded.
  Location: <maps url>. Please call them or 112." (≤ 160 chars, via `sendSms`, visible in the ops SMS log when simulated).
- Requester screen: when the request is escalated, a modal with an **audio alarm** and one big button
  **"No local helper responded · Tap to call 112 immediately"** (`tel:112`); it says whether the emergency contact was
  texted. The client also schedules a `tick` at `createdAt + fallbackMs` so the server flips on time.

---

## File ownership (parallel builders — touch only your files)

| Builder | Files |
|---|---|
| `triage` | lib/triage.ts, lib/triage-rules.ts, app/api/triage/route.ts, tests/triage.test.ts, tests/triage-rules.test.ts, tests/hazards.test.ts |
| `engine` | lib/dispatch.ts, lib/waves.ts, lib/escrow.ts, lib/feed.ts, lib/validate.ts, app/api/requests/route.ts, app/api/requests/[id]/accept/route.ts, app/api/dispatches/[id]/respond/route.ts, app/api/incident/payout/route.ts, app/api/helpers/route.ts, app/api/twilio/inbound/route.ts, scripts/seed.ts, tests/waves.test.ts, tests/upgrade-engine.test.ts |
| `app-ui` | app/page.tsx, lib/client/speech.ts, components/VoiceMic.tsx |
| `track-ui` | components/RequestView.tsx, components/ActiveJob.tsx, components/HazardBanner.tsx, components/FallbackModal.tsx, app/ops/page.tsx, app/demo/page.tsx |

Shared, read-only for everyone: lib/types.ts, lib/policy.ts, lib/hazards.ts, lib/taxonomy.ts, lib/views.ts, components/TrustBadge.tsx,
components/ui.tsx, components/icons.tsx, components/skills.tsx, components/equipment.tsx, lib/client/api.ts, lib/client/sse.ts.
