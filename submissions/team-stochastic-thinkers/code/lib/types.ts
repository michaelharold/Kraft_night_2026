/**
 * Sahaya shared types (README §8, CONTRACTS §2).
 *
 * All timestamps are ISO-8601 strings (JSON-safe, adapter-agnostic). Ids are
 * `crypto.randomUUID()` except seeded helpers (`seed-helper-01` … `seed-helper-30`).
 * The README's `Request` entity is named `HelpRequest` in code because `Request`
 * collides with the Fetch API global.
 *
 * The unions below are derived from the `as const` arrays in ./taxonomy. That import
 * is type-only (erased at compile time), so this file has no runtime dependencies and
 * `scripts/seed.ts` can `import type` from it under Node's type stripping.
 */
import type { NEED_TYPES, SKILLS, URGENCIES, Equipment, Tool } from "./taxonomy";
export type { Tool } from "./taxonomy";
export type { Equipment } from "./taxonomy";
import type { HazardKind } from "./hazards";
import type { LanguageCode } from "./languages";
export type { LanguageCode } from "./languages";
export type { HazardKind } from "./hazards";

export type Skill = (typeof SKILLS)[number];
export type NeedType = (typeof NEED_TYPES)[number];
export type Urgency = (typeof URGENCIES)[number];

export type LatLng = { lat: number; lng: number };
export type Channel = "app" | "sms";

export type Helper = {
  id: string;
  name: string;
  phone: string; // E.164, e.g. "+919000000001"
  skills: Skill[];
  location: LatLng | null;
  onDuty: boolean;
  reliability: number; // 0..1, starts 0.7 (INITIAL_RELIABILITY)
  lastSeen: string;
  equipment?: Equipment[]; // what they own that helps in an emergency
  trustTier?: TrustTier;        // read via tierOf() — absent on older records = TIER_1_NEIGHBOR
  credentialId?: string | null; // licence / registration number given for Tier 2 / Tier 3 (self-declared in the demo)
  walletBalance?: number;       // RUPEES. read via walletOf() — credited when a disaster-era escrow is released
  walletPaise?: number;         // PAISE.  read via walletPaiseOf() — credited when a service job is paid for.
                                // Deliberately NOT walletBalance: the two paths use different units, and summing
                                // them into one number would silently value a ₹500 callout fee at ₹5.
  availabilityPausedAt?: string | null; // set when availability was switched off automatically because this person asked for help
  rates?: Partial<Record<Skill, RateRange>>; // what the provider charges per service (₹, shown to people requesting it)
  idProof?: IdProof | null;                  // uploaded identity document and its verification status
  toolsOnHand?: Tool[];                      // tools the provider carries (matched against the AI's required tools)
  profile?: UserProfile;   // basic details collected at sign-up
  language?: LanguageCode; // read via languageOf() — the language they read, speak and are called in
};

/** Basic details every user gives at sign-up. Shared with the person on the other side of an accepted request. */
export type UserProfile = {
  age: number | null; bloodGroup: string | null; address: string | null; medicalNotes: string | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null;
};

export type TriageResult = {
  type: NeedType;
  urgency: Urgency;
  skills: Skill[]; // never empty: falls back to TYPE_SKILLS[type]
  summary: string;
  confidence: number; // 0..1
  source: "ollama" | "rules";
  // CLARIFYING_QUESTION when source === "rules" && confidence < 0.5; never blocks dispatch (CONTRACTS §6)
  clarifyingQuestion: string | null;
  equipment: Equipment[]; // equipment the situation specifically calls for ("need a pump" → water_pump); may be empty
  hazardAlert: HazardAlert; // hidden scene hazard; texts are curated (lib/hazards.ts), only the kind is classified
};

/** Hazard warning shown to the requester. hazardTitle/hazardAction are null when hasHazard is false. */
export type HazardAlert = { hasHazard: boolean; kind: HazardKind; hazardTitle: string | null; hazardAction: string | null };

// ─── Upgrade: monetization, trust tiers ──────────────────────────────────────────────────────────────────────
export type RequestCategory = "LIFE_SAFETY" | "HOUSEHOLD_MICROGIG" | "SERVICE";
export type EscrowStatus = "HELD" | "RELEASED" | "REFUNDED";
export type GigType = "plumbing" | "electrical" | "generator_power" | "other_repair";
export type TrustTier = "TIER_1_NEIGHBOR" | "TIER_2_CERTIFIED_PRO" | "TIER_3_FIRST_RESPONDER";

export type RequestStatus = "triaging" | "searching" | "matched" | "resolved" | "escalated" | "cancelled";
export type RequesterRole = "self" | "other";
export type LocationSource = "gps" | "landmark" | "none";

export type HelpRequest = {
  id: string;
  requesterId: string; // app: x-resq-uid; sms: "sms:+91..."
  requesterName: string | null; // optional, app requests: shown to the accepted helper only
  requesterPhone: string | null; // SMS sender, or the optional phone an app requester gave; shown to the accepted helper only
  // The requester's own helper record, if any — excluded from selectWave.
  // app: getHelperSession(req)?.helperId ?? null; sms: (await store.getHelperByPhone(phone))?.id ?? null
  requesterHelperId: string | null;
  description: string;
  location: LatLng | null;
  locationSource: LocationSource;
  landmark: string | null;
  channel: Channel;
  role: RequesterRole; // "self" = the requester is the person in trouble; "other" = a witness/bystander
  requesterProfile?: UserProfile | null; // snapshot of the signed-in requester's profile at request time
  category?: RequestCategory;          // read via categoryOf() — absent = LIFE_SAFETY
  gigType?: GigType | null;            // set for HOUSEHOLD_MICROGIG
  calloutFee?: number;                 // 0 for LIFE_SAFETY; one of CALLOUT_FEES for a micro-gig
  escrowStatus?: EscrowStatus | null;  // null = no escrow (free request)
  upgradedToLifeSafety?: boolean;      // filed as a paid job but converted to a free emergency by the safety override
  fallbackAt?: string | null;          // when the 3-minute / all-waves fallback fired (LIFE_SAFETY)
  emergencyContactNotifiedAt?: string | null; // when the requester's emergency contact was texted
  service?: Skill | null;               // SERVICE requests: the service the user tapped (plumber, electrician, doctor…)
  paymentStatus?: PaymentStatus | null;  // SERVICE requests after completion; read via paymentStatusOf()
  servicePaise?: number | null;          // the worker's final charge for the work, entered when they mark the job done
  scope?: TaskScope | null;              // AI job breakdown (set when the request came through /api/scope-task)
  shortCode?: string | null;             // 4-digit code providers reply with by SMS: "ACCEPT 1234"
  aiMatchedWorkerIds?: string[];         // providers the AI matching engine picked (skills + tools); shown as "Matched for you"
  attachments?: JobPhoto[];              // photos the customer took for the AI's photo requests (visible to the accepted worker only)
  answers?: { question: string; answer: string }[]; // customer's answers to the AI's questions (visible to the accepted worker only)
  triage: TriageResult | null;
  status: RequestStatus;
  wave: number; // 0 before dispatch starts, 1..4 while searching
  radiusKm: number; // WAVE_RADII_KM[wave-1], 0 before dispatch
  waveStartedAt: string | null; // when the current wave's pings went out; null before wave 1 and after escalate
  matchedHelperId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DispatchStatus = "pinged" | "accepted" | "rejected" | "expired" | "cancelled";

export type Dispatch = {
  id: string;
  requestId: string;
  helperId: string;
  wave: number;
  score: number;
  distanceKm: number;
  // Records how the helper answered: created as "app"; the inbound webhook sets it to "sms" on the
  // dispatch it accepts or rejects (waves.accept / waves.onReject with via: "sms"). Shown as a badge
  // on /ops; nothing else reads it.
  channel: Channel;
  status: DispatchStatus;
  pingedAt: string;
  respondedAt: string | null;
};

export type Rating = { id: string; requestId: string; helperId: string; stars: number; createdAt: string };

export type Otp = { phone: string; code: string; expiresAt: string; attempts: number }; // attempts = wrong tries so far, starts 0

// Wire shapes (what routes return). Defined here so client and server share them.

export type GuidanceCard = {
  type: NeedType;
  title: string;
  steps: string[];
  doNot: string[];
  call112When: string[];
  source: string;
  selfSteps: string[]; // shown when the person describing it IS the person in trouble (role "self")
};

/** Public projection of a dispatch for the requester: no helper name/phone. */
export type DispatchPublic = Pick<Dispatch, "id" | "wave" | "status" | "distanceKm" | "pingedAt"> & {
  helperSkills: Skill[];
  helperTier: TrustTier;
};

/** The matched helper as shown to the requester; distanceKm = the accepted dispatch's distanceKm. */
export type HelperPublic = Pick<Helper, "id" | "name" | "skills" | "phone" | "location" | "reliability" | "equipment"> & { distanceKm: number | null; trustTier: TrustTier; verified: boolean; rate: RateRange | null };

/** GET /api/requests/:id, POST .../tick, requester SSE snapshot. */
export type RequestView = {
  request: HelpRequest;
  dispatches: DispatchPublic[];
  guidance: GuidanceCard | null;
  matchedHelper: HelperPublic | null;
  waveEndsAt: string | null; // waveStartedAt + WAVE_WINDOW_MS while status === "searching"; null otherwise
};

/** Helper SSE snapshot item / GET /api/helpers/me. */
export type IncomingCard = {
  dispatch: Dispatch;
  request: Pick<HelpRequest, "id" | "description" | "triage" | "status" | "createdAt" | "wave">;
  expiresAt: string; // dispatch.pingedAt + WAVE_WINDOW_MS
};

export type HelperView = {
  helper: Helper | null;
  pinged: IncomingCard[];
  active: { request: HelpRequest; mapsUrl: string | null } | null;
};

export type OpsView = {
  requests: HelpRequest[];
  helpers: Helper[];
  dispatches: Dispatch[];
  center: LatLng;
  generatedAt: string;
};

export type StoreErrorReason = "already_matched" | "expired" | "not_found" | "busy";

// ─── Disaster response (authorities) ─────────────────────────────────────────────────────────────────────────

export type PingSource = "gps" | "demo" | "request" | "seed";
/** Last known location of a person (signed-in user, helper, or SMS/app requester), keyed by phone. */
export type UserLocation = {
  phone: string; name: string | null; helperId: string | null;
  location: LatLng; accuracyM: number | null; source: PingSource; updatedAt: string;
  history: { lat: number; lng: number; at: string }[]; // last 24 h, oldest first, thinned to one point per minute
};
export type ZoneKind = "landslide" | "flood" | "fire" | "building_collapse" | "cyclone" | "other";
export type Zone = { id: string; name: string; kind: ZoneKind; center: LatLng; radiusKm: number; createdAt: string; createdBy: string; active: boolean };
export type AuthorityRole = "admin" | "officer";
export type Authority = { username: string; name: string; role: AuthorityRole; passwordHash: string; createdAt: string };
export type AuditEntry = { at: string; user: string; action: string; detail: string };

// ─── Community services marketplace ──────────────────────────────────────────────────────────────────────────
export type RateRange = { min: number; max: number };
export type VerificationStatus = "pending" | "verified" | "rejected";
export type IdProof = {
  fileId: string | null; fileName: string; mime: string; size: number; uploadedAt: string;
  status: VerificationStatus; reviewedBy: string | null; reviewedAt: string | null; note: string | null;
};

/** Structured job breakdown produced by the local AI (lib/scope.ts). */
export type SkillLevel = "basic" | "intermediate" | "expert";
export type TaskScope = {
  parsedTitle: string;            // short job title, e.g. "Fix leaking kitchen sink pipe"
  category: Skill;                // one of SERVICES
  urgencyScore: number;           // 1 (whenever) … 10 (right now)
  estimatedTimeMinutes: number;   // 10 … 480
  requiredTools: Tool[];          // from TOOLS
  skillLevelRequired: SkillLevel;
  workerMatchingTags: Skill[];    // services that could do this job (always includes category)
  steps: string[];                // short job breakdown (2–5 steps) shown to the customer and provider
  photoRequests: PhotoRequest[];  // 1–4 photos the customer should take so the worker can prepare (what, angle, why)
  questions: string[];            // 0–3 short questions whose answers help the worker bring the right parts
  model: string;                  // which local model produced it
  source: "ollama";
};
export type PhotoRequest = { what: string; angle: string; why: string };
export type JobPhoto = { id: string; fileId: string; label: string; angle: string; mime: string; size: number; uploadedAt: string };

// ── Payments, commission and receipt reimbursement (lib/money.ts, lib/razorpay.ts, lib/receipts.ts) ──────────
/**
 * "due" the job is done and the customer owes; "processing" a Razorpay order is open; "paid" settled and the
 * worker's wallet credited; "failed" the gateway declined (the customer can retry); "refunded" reversed.
 */
export type PaymentStatus = "due" | "processing" | "paid" | "failed" | "refunded";

/** One attempt to settle one job. Amounts are paise; the split is computed by lib/money.ts computeSettlement(). */
export type Payment = {
  id: string;
  requestId: string;
  customerId: string | null;   // the requester's helper id (they are a signed-in user too)
  workerId: string;            // who gets the payout
  provider: "razorpay" | "demo";
  orderId: string;             // Razorpay order id, or "order_demo_…" when no keys are configured
  paymentId: string | null;    // Razorpay payment id, set once the customer has paid
  servicePaise: number;
  reimbursementPaise: number;
  commissionPct: number;
  commissionPaise: number;
  grossPaise: number;          // charged to the customer = service + reimbursement
  payoutPaise: number;         // credited to the worker  = gross - commission
  status: "created" | "paid" | "failed" | "refunded";
  error: string | null;        // gateway or verification failure, shown to the customer verbatim-free
  createdAt: string;
  paidAt: string | null;
};

/** One line the vision model read off a receipt. amountPaise is null when the model could not read a figure. */
export type ReceiptItem = { name: string; qty: number | null; amountPaise: number | null };

/** What the local vision model made of a receipt photo. Advisory: the customer still approves the amount. */
export type ReceiptAnalysis = {
  looksLikeReceipt: boolean;
  merchant: string | null;
  purchasedAt: string | null;  // as printed on the receipt, free text — not parsed into a Date
  items: ReceiptItem[];
  totalPaise: number | null;
  confidence: number;          // 0..1, the model's own confidence, clamped
  model: string;               // which vision model read it
  source: "ollama" | "manual"; // "manual" = no vision model available, the worker typed the amount
  note: string | null;         // why an analysis is missing or was overridden
};

/**
 * Money a worker spent on parts mid-job, claimed back from the customer. The AI reads the receipt; the CUSTOMER
 * approves it. Approved reimbursements are added to the bill and paid to the worker without commission.
 */
export type Reimbursement = {
  id: string;
  requestId: string;
  workerId: string;
  fileId: string;              // GridFS id of the receipt image
  mime: string;
  size: number;
  analysis: ReceiptAnalysis | null;
  claimedPaise: number;        // what the worker is claiming (defaults to the AI total, editable by the worker)
  note: string | null;         // worker's note, e.g. "new 1/2 inch tap + teflon tape"
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;    // customer's helper id
};

// ── Voice relay across a language barrier (lib/languages.ts, lib/translate.ts, lib/voice.ts) ─────────────────
/**
 * One spoken (or typed) message carried between two people who do not share a language.
 *
 * Both halves are kept forever: `sourceText` is what the person actually said, `translatedText` is what the other
 * person was shown or read out to them. When a translation fails we still deliver — with the original and an
 * honest note — because a message someone can puzzle out beats silence, and because nobody should discover after
 * the fact that a machine quietly reworded their emergency.
 *
 * `recordingUrl` is the original audio when the message came in by phone. The recipient can play the real voice
 * instead of trusting the transcript, which matters when a name or a house number is misheard.
 */
export type VoiceMessageStatus = "captured" | "delivering" | "delivered" | "failed";

export type VoiceMessage = {
  id: string;
  requestId: string;
  seq: number;                       // 1, 2, 3… the order of turns in this conversation
  fromRole: "requester" | "helper";
  fromHelperId: string | null;       // null when an unregistered person phoned in
  fromPhone: string | null;
  toHelperId: string | null;
  toPhone: string | null;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  sourceText: string;                // what they said, in their own language
  translatedText: string;            // what the other person gets; equals sourceText when translation failed
  translationSource: "sarvam" | "ollama" | "passthrough" | "failed";
  translationNote: string | null;    // shown beside the message when something went wrong
  channel: "app" | "call";           // typed/spoken in the app, or phoned in
  recordingUrl: string | null;       // Twilio recording of the original voice, when there is one
  hasSpokenAudio?: boolean;          // a translated reading of this message is available to play in-app
  recordingSec: number | null;
  status: VoiceMessageStatus;
  deliveryRef: string | null;        // Twilio Call SID of the outbound call that read it out, or "simulated"
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
};
