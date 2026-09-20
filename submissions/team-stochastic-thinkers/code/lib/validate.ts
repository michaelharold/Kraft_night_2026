/** Hand-written input guards shared by every route (README §10 rule 6). */
import { BLOOD_GROUPS, SKILLS, isEquipment, isSkill, isTool, type Tool } from "./taxonomy";
import { GIG_TYPES, isCalloutFee, isGigType, isTrustTier, tierOf } from "./policy";
import type { Equipment, GigType, RequestCategory, TrustTier, UserProfile } from "./types";
import type { LatLng, Skill } from "./types";

export function isLatLng(x: unknown): x is LatLng {
  if (!x || typeof x !== "object") return false;
  const { lat, lng } = x as Record<string, unknown>;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
export function isUid(x: unknown): x is string {
  return typeof x === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(x);
}
export function text(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}
export function isStars(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 5;
}
export function skillsOf(x: unknown): Skill[] | null {
  if (!Array.isArray(x)) return null;
  if (!x.every(isSkill)) return null;
  const out = [...new Set(x as Skill[])];
  return out.length >= 1 && out.length <= SKILLS.length ? out : null;
}
/** Skills may be empty now: everyone signs up, not only people with special skills. */
export function skillsOrEmpty(x: unknown): Skill[] | null {
  if (x === undefined) return [];
  if (!Array.isArray(x) || !x.every(isSkill)) return null;
  return [...new Set(x as Skill[])];
}
export function equipmentOf(x: unknown): Equipment[] | null {
  if (x === undefined) return [];
  if (!Array.isArray(x) || !x.every(isEquipment)) return null;
  return [...new Set(x as Equipment[])];
}
/** Hand-validated profile; returns an error field name on failure. */
export function profileOf(x: unknown, normalizePhone: (p: unknown) => string | null): { ok: true; value: UserProfile } | { ok: false; field: string } {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const opt = (v: unknown, max: number) => (v === undefined || v === null || v === "" ? null : text(v, max));
  const age = o.age === undefined || o.age === null || o.age === "" ? null : Number(o.age);
  if (age !== null && !(Number.isInteger(age) && age >= 1 && age <= 120)) return { ok: false, field: "age" };
  const bloodGroup = opt(o.bloodGroup, 3);
  if (bloodGroup !== null && !(BLOOD_GROUPS as readonly string[]).includes(bloodGroup)) return { ok: false, field: "bloodGroup" };
  const address = opt(o.address, 200);
  if (o.address && address === null) return { ok: false, field: "address" };
  const medicalNotes = opt(o.medicalNotes, 300);
  if (o.medicalNotes && medicalNotes === null) return { ok: false, field: "medicalNotes" };
  const emergencyContactName = opt(o.emergencyContactName, 60);
  const ecp = o.emergencyContactPhone;
  const emergencyContactPhone = ecp === undefined || ecp === null || ecp === "" ? null : normalizePhone(ecp);
  if (ecp && !emergencyContactPhone) return { ok: false, field: "emergencyContactPhone" };
  return { ok: true, value: { age, bloodGroup, address, medicalNotes, emergencyContactName, emergencyContactPhone } };
}

/**
 * Own-key gig type guard. lib/policy.ts `isGigType` tests `x in GIG_TYPES`, which is also true for inherited keys
 * ("toString", "constructor", "__proto__" …); GIG_TYPES[x].skills would then throw. Use this one for untrusted input.
 */
export function isKnownGigType(x: unknown): x is GigType {
  return isGigType(x) && Object.prototype.hasOwnProperty.call(GIG_TYPES, x);
}

/**
 * category / gigType / calloutFee of POST /api/requests (docs/UPGRADE.md §1). Absent category = LIFE_SAFETY.
 * A life-safety request is always free, so gigType / calloutFee sent with it are ignored rather than rejected:
 * a cry for help is never refused over a payment field.
 */
export function pricingOf(b: Record<string, unknown>):
  | { ok: true; value: { category: RequestCategory; gigType: GigType | null; calloutFee: number } }
  | { ok: false; error: "category_invalid" | "gigType_invalid" | "calloutFee_invalid" } {
  const category = b.category === undefined || b.category === null ? "LIFE_SAFETY" : b.category;
  if (category !== "LIFE_SAFETY" && category !== "HOUSEHOLD_MICROGIG") return { ok: false, error: "category_invalid" };
  if (category === "LIFE_SAFETY") return { ok: true, value: { category, gigType: null, calloutFee: 0 } };
  if (!isKnownGigType(b.gigType)) return { ok: false, error: "gigType_invalid" };
  if (!isCalloutFee(b.calloutFee)) return { ok: false, error: "calloutFee_invalid" };
  return { ok: true, value: { category, gigType: b.gigType, calloutFee: b.calloutFee } };
}

/**
 * trustTier + credentialId of POST /api/helpers (docs/UPGRADE.md §3). Absent fields keep the stored values;
 * credentialId null / "" clears it. Tier 2 and Tier 3 need a licence / registration number of 3–40 characters.
 * Tiers are self-declared in the demo: nothing here verifies the number.
 */
export function trustOf(b: Record<string, unknown>, existing: { trustTier?: TrustTier; credentialId?: string | null } | null):
  | { ok: true; value: { trustTier: TrustTier; credentialId: string | null } }
  | { ok: false; error: "trustTier_invalid" | "credentialId_invalid" } {
  if (b.trustTier !== undefined && !isTrustTier(b.trustTier)) return { ok: false, error: "trustTier_invalid" };
  const trustTier: TrustTier = isTrustTier(b.trustTier) ? b.trustTier : tierOf(existing);
  let credentialId: string | null;
  if (b.credentialId === undefined) credentialId = existing?.credentialId ?? null;
  else if (b.credentialId === null || b.credentialId === "") credentialId = null;
  else {
    credentialId = text(b.credentialId, 40);
    if (credentialId === null || credentialId.length < 3) return { ok: false, error: "credentialId_invalid" };
  }
  if (trustTier !== "TIER_1_NEIGHBOR" && credentialId === null) return { ok: false, error: "credentialId_invalid" };
  return { ok: true, value: { trustTier, credentialId } };
}

/** { plumber: { min, max }, … } — every key must be one of the provider's skills; whole rupees 0–1,00,000, min ≤ max. */
export function ratesOf(x: unknown, skills: Skill[]): { ok: true; value: Partial<Record<Skill, { min: number; max: number }>> } | { ok: false } {
  if (x === undefined || x === null) return { ok: true, value: {} };
  if (typeof x !== "object" || Array.isArray(x)) return { ok: false };
  const out: Partial<Record<Skill, { min: number; max: number }>> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!isSkill(k) || !skills.includes(k)) return { ok: false };
    const { min, max } = (v ?? {}) as Record<string, unknown>;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000;
    if (!ok(min) || !ok(max) || min > max) return { ok: false };
    out[k] = { min, max };
  }
  return { ok: true, value: out };
}

export function toolsOf(x: unknown): Tool[] | null {
  if (x === undefined) return [];
  if (!Array.isArray(x) || !x.every(isTool)) return null;
  return [...new Set(x as Tool[])];
}

export async function readJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const raw = await req.text();
    if (!raw.trim()) return { ok: false };
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}
export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}
export function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error, ...extra }, { status });
}
/** Wraps a handler so an unexpected throw becomes 500 { error: "internal" }. */
export function safe<A extends unknown[]>(fn: (...a: A) => Promise<Response>): (...a: A) => Promise<Response> {
  return async (...a: A) => {
    try {
      return await fn(...a);
    } catch (e) {
      console.error("[route]", e);
      return jsonError(500, "internal");
    }
  };
}
