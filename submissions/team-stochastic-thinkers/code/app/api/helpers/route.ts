import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import { getHelperSession, isOps } from "@/lib/auth";
import { emit } from "@/lib/events";
import { INITIAL_RELIABILITY } from "@/lib/dispatch";
import { HELPER_SESSION_MAX_AGE_SEC, SESSION_COOKIE, isSecureRequest, serializeCookie, sign } from "@/lib/session";
import { normalizePhone } from "@/lib/sms";
import { equipmentOf, isLatLng, json, jsonError, profileOf, ratesOf, readJson, safe, skillsOrEmpty, text, toolsOf, trustOf } from "@/lib/validate";
import { isLanguage } from "@/lib/languages";
import { withHelperLock } from "@/lib/escrow";
import { walletOf, walletPaiseOf } from "@/lib/policy";
import { onReject } from "@/lib/waves";
import type { Helper } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/helpers — create or update an account (self-service with a session, or any helper as ops).
 * Upgrade fields: trustTier (TIER_1_NEIGHBOR default) and credentialId (3–40 chars, required for Tier 2 / Tier 3;
 * self-declared in the demo, nothing is verified). Absent fields keep the stored values.
 * Neither wallet is EVER read from the body, not even for ops: only an escrow release (lib/escrow.ts) or a
 * settled payment (lib/payments.ts) credits them. Both are re-read from the stored record inside the lock.
 */
export const POST = safe(async (req: Request) => {
  const ops = isOps(req);
  const s = getHelperSession(req);
  if (!ops && !s) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  const name = text(b.name, 60);
  if (!name) return jsonError(400, "name_invalid");
  const phone = normalizePhone(b.phone);
  if (!phone) return jsonError(400, "phone_invalid");
  const skills = skillsOrEmpty(b.skills);
  if (!skills) return jsonError(400, "skills_invalid");
  const equipment = equipmentOf(b.equipment);
  if (!equipment) return jsonError(400, "equipment_invalid");
  const rates = ratesOf(b.rates, skills);
  if (!rates.ok) return jsonError(400, "rates_invalid");
  const tools = toolsOf(b.toolsOnHand);
  if (!tools) return jsonError(400, "toolsOnHand_invalid");
  if (b.verified !== undefined && typeof b.verified !== "boolean") return jsonError(400, "verified_invalid");
  const prof = b.profile === undefined ? null : profileOf(b.profile, normalizePhone);
  if (prof && !prof.ok) return jsonError(400, `${prof.field}_invalid`);
  if (b.location !== undefined && b.location !== null && !isLatLng(b.location)) return jsonError(400, "location_invalid");
  if (b.onDuty !== undefined && typeof b.onDuty !== "boolean") return jsonError(400, "onDuty_invalid");
  if (b.reliability !== undefined && !(typeof b.reliability === "number" && b.reliability >= 0 && b.reliability <= 1)) return jsonError(400, "reliability_invalid");
  if (b.lastSeen !== undefined && !(typeof b.lastSeen === "string" && Number.isFinite(Date.parse(b.lastSeen)))) return jsonError(400, "lastSeen_invalid");
  if (b.id !== undefined && typeof b.id !== "string") return jsonError(400, "id_invalid");
  const store = getStore();
  let existing: Helper | null;
  if (!ops && s) {
    if (phone !== s.phone) return jsonError(403, "forbidden");
    if (b.id !== undefined && b.id !== s.helperId) return jsonError(403, "forbidden");
    if (b.reliability !== undefined || b.lastSeen !== undefined || b.verified !== undefined) return jsonError(403, "forbidden");
    existing = await store.getHelperByPhone(phone);
  } else {
    existing = typeof b.id === "string" ? await store.getHelper(b.id) : await store.getHelperByPhone(phone);
  }
  const trust = trustOf(b, existing);
  if (!trust.ok) return jsonError(400, trust.error);
  const now = new Date().toISOString();
  const id = existing?.id ?? (typeof b.id === "string" ? b.id : randomUUID());
  // The wallet is re-read inside the helper lock, so a payout landing while this profile is being saved is not lost.
  const helper = await withHelperLock(id, async () => { const fresh = await store.getHelper(id); return store.upsertHelper({
    ...(fresh ?? {}), // keep everything this form does not edit (ID proof, pause marker, …)
    id,
    name, phone, skills,
    location: isLatLng(b.location) ? b.location : b.location === null ? null : existing?.location ?? null,
    onDuty: typeof b.onDuty === "boolean" ? b.onDuty : existing?.onDuty ?? false,
    reliability: typeof b.reliability === "number" ? b.reliability : existing?.reliability ?? INITIAL_RELIABILITY,
    lastSeen: typeof b.lastSeen === "string" ? b.lastSeen : existing?.lastSeen ?? now,
    equipment: b.equipment === undefined ? existing?.equipment ?? [] : equipment,
    trustTier: trust.value.trustTier,
    credentialId: trust.value.credentialId,
    walletBalance: walletOf(fresh),
    walletPaise: walletPaiseOf(fresh),
    rates: b.rates === undefined ? fresh?.rates ?? {} : rates.value,
    toolsOnHand: b.toolsOnHand === undefined ? fresh?.toolsOnHand ?? [] : tools,
    // An unrecognised language is ignored rather than rejected: a bad value must never block someone saving a profile.
    ...(isLanguage(b.language) ? { language: b.language } : fresh?.language ? { language: fresh.language } : {}),
    idProof: ops && typeof b.verified === "boolean"
      ? (b.verified ? { fileId: null, fileName: "verified by admin", mime: "", size: 0, uploadedAt: now, status: "verified" as const, reviewedBy: "admin", reviewedAt: now, note: null } : null)
      : fresh?.idProof ?? null,
    ...(prof?.ok ? { profile: prof.value } : fresh?.profile ? { profile: fresh.profile } : {}),
  }); });
  emit("helper:updated", { helper });
  const headers: HeadersInit = {};
  let token: string | undefined;
  if (!ops && s) {
    token = sign({ phone, helperId: helper.id, exp: Date.now() + HELPER_SESSION_MAX_AGE_SEC * 1000 });
    headers["set-cookie"] = serializeCookie(SESSION_COOKIE, token, { maxAgeSec: HELPER_SESSION_MAX_AGE_SEC, secure: isSecureRequest(req) });
  }
  return json({ helper, token }, 200, headers);
});

export const PATCH = safe(async (req: Request) => {
  const ops = isOps(req);
  const s = getHelperSession(req);
  if (!ops && !s) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  let id: string;
  if (!ops && s) {
    if (!s.helperId) return jsonError(401, "unauthenticated");
    id = s.helperId;
  } else {
    if (typeof b.id !== "string") return jsonError(400, "id_invalid");
    id = b.id;
  }
  if (b.onDuty !== undefined && typeof b.onDuty !== "boolean") return jsonError(400, "onDuty_invalid");
  if (b.location !== undefined && !isLatLng(b.location)) return jsonError(400, "location_invalid");
  if (b.onDuty === undefined && b.location === undefined) return jsonError(400, "body_invalid");
  const store = getStore();
  const cur = await store.getHelper(id);
  if (!cur) return jsonError(404, "not_found");
  const helper = (await store.setOnDuty(id, typeof b.onDuty === "boolean" ? b.onDuty : cur.onDuty, isLatLng(b.location) ? b.location : undefined)) as Helper;
  emit("helper:updated", { helper });
  if (b.onDuty === false) for (const d of await store.listPingedForHelper(id)) await onReject(d.id);
  if (b.onDuty === true && helper.availabilityPausedAt) {
    const cleared = await store.upsertHelper({ ...helper, availabilityPausedAt: null });
    emit("helper:updated", { helper: cleared });
    return json({ helper: cleared });
  }
  return json({ helper });
});
