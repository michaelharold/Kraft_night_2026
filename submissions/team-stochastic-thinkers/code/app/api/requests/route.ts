import { getHelperSession, getRequesterId } from "@/lib/auth";
import { isLatLng, json, jsonError, pricingOf, readJson, safe, text } from "@/lib/validate";
import { normalizePhone } from "@/lib/sms";
import { getStore } from "@/lib/store";
import { createHelpRequest, createServiceRequest, onReject } from "@/lib/waves";
import { isService } from "@/lib/taxonomy";
import { emit } from "@/lib/events";
import { buildRequestView } from "@/lib/views";

export const dynamic = "force-dynamic";

/**
 * POST /api/requests → 201 RequestView.
 * Body: { description, location?, role?, name?, phone?, category?, gigType?, calloutFee? }.
 * category defaults to LIFE_SAFETY (always free). HOUSEHOLD_MICROGIG needs gigType + calloutFee ∈ CALLOUT_FEES and a
 * signed-in account (401): money is only ever held for, and refunded to, a known person. The fee is held in the
 * in-memory escrow; if triage finds an emergency the request is converted to a free life-safety request (lib/waves.ts).
 */
export const POST = safe(async (req: Request) => {
  // Signed-in users (the normal path): name, phone and profile come from their account.
  const session = getHelperSession(req);
  const account = session?.helperId ? await getStore().getHelper(session.helperId) : null;
  const requesterId = account ? `acct:${account.id}` : getRequesterId(req);
  if (!requesterId) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const description = text(body.value.description, 1000);
  if (!description) return jsonError(400, "description_invalid");
  const loc = body.value.location;
  if (loc !== undefined && loc !== null && !isLatLng(loc)) return jsonError(400, "location_invalid");
  const location = isLatLng(loc) ? loc : null;
  const role = body.value.role;
  if (role !== undefined && role !== "self" && role !== "other") return jsonError(400, "role_invalid");
  const b = body.value;
  // Community services (the main flow): the user tapped a service and described the problem.
  if (b.service !== undefined) {
    if (!isService(b.service)) return jsonError(400, "service_invalid");
    if (!account) return jsonError(401, "unauthenticated", { detail: "Sign in to request a service." });
    // NOTE: booking a service no longer pauses the requester's own availability. That rule existed because
    // booking a doctor or nurse for yourself meant you were unwell and could not work; it does not follow for a
    // trade. Someone who books a plumber for a leaking sink is perfectly able to take an electrical job an hour
    // later, and switching their availability off would quietly cost them work.
    const svc = await createServiceRequest({ service: b.service, description, location, account });
    return json(await buildRequestView(svc.id), 201);
  }
  const requesterName = b.name === undefined || b.name === "" ? null : text(b.name, 60);
  if (requesterName === null && b.name !== undefined && b.name !== "") return jsonError(400, "name_invalid");
  const requesterPhone = b.phone === undefined || b.phone === "" ? null : normalizePhone(b.phone);
  if (requesterPhone === null && b.phone !== undefined && b.phone !== "") return jsonError(400, "phone_invalid");
  const pricing = pricingOf(b);
  if (!pricing.ok) return jsonError(400, pricing.error);
  if (pricing.value.category === "HOUSEHOLD_MICROGIG" && !account) return jsonError(401, "unauthenticated", { detail: "A paid household job needs a signed-in account." });
  // Someone who asks for help is not available to help others: pause their availability (they switch it back on
  // themselves when they are safe) and hand any pings they were holding to the next helper.
  if (account) {
    const fresh = await getStore().getHelper(account.id);
    if (fresh?.onDuty) {
      const paused = await getStore().upsertHelper({ ...fresh, onDuty: false, availabilityPausedAt: new Date().toISOString() });
      emit("helper:updated", { helper: paused });
      for (const d of await getStore().listPingedForHelper(account.id)) await onReject(d.id);
    }
  }
  const r = await createHelpRequest({
    requesterId, requesterPhone: requesterPhone ?? account?.phone ?? null, requesterName: requesterName ?? account?.name ?? null,
    requesterProfile: account?.profile ?? null, requesterHelperId: account?.id ?? null, description,
    location, locationSource: location ? "gps" : "none", landmark: null, channel: "app", role,
    category: pricing.value.category, gigType: pricing.value.gigType, calloutFee: pricing.value.calloutFee,
  });
  return json(await buildRequestView(r.id), 201);
});
