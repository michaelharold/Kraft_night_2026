import { getHelperSession } from "@/lib/auth";
import { REQUIRED_TIER_FOR_GIG } from "@/lib/policy";
import { json, jsonError, safe } from "@/lib/validate";
import { claim } from "@/lib/waves";

export const dynamic = "force-dynamic";

/**
 * "I'll help": take the request from the feed. On success both sides get each other's details.
 * 403 tier_required: a paid household job may only be accepted by a TIER_2_CERTIFIED_PRO.
 */
export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const r = await claim(id, s.helperId);
  if (r.ok) return json(r);
  if (r.reason === "service_mismatch") return json({ ok: false, reason: r.reason, error: r.reason, detail: "You don't offer this service." }, 403);
  if (r.reason === "tier_required") return json({ ok: false, reason: r.reason, error: r.reason, requiredTier: REQUIRED_TIER_FOR_GIG }, 403);
  return json({ ok: false, reason: r.reason, error: r.reason }, r.reason === "not_found" ? 404 : 409);
});
