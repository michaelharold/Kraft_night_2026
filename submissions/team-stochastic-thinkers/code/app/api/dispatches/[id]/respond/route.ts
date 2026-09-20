import { getStore } from "@/lib/store";
import { getHelperSession, isOps } from "@/lib/auth";
import { REQUIRED_TIER_FOR_GIG } from "@/lib/policy";
import { json, jsonError, readJson, safe } from "@/lib/validate";
import { accept, onReject } from "@/lib/waves";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const action = body.value.action;
  if (action !== "accept" && action !== "reject") return jsonError(400, "action_invalid");
  const d = await getStore().getDispatch(id);
  if (!d) return jsonError(404, "not_found");
  const ops = isOps(req);
  const s = getHelperSession(req);
  if (!ops && !s) return jsonError(401, "unauthenticated");
  if (!ops && s?.helperId !== d.helperId) return jsonError(403, "forbidden");
  if (action === "accept") {
    const r = await accept(id, "app");
    if (r.ok) return json(r);
    // A paid household job may only be accepted by a Certified Pro (also when ops accepts on a helper's behalf).
    if (r.reason === "tier_required") return json({ ok: false, reason: r.reason, error: r.reason, requiredTier: REQUIRED_TIER_FOR_GIG }, 403);
    return json({ ok: false, reason: r.reason, error: r.reason }, 409);
  }
  const r = await onReject(id, "app");
  return r.ok ? json(r) : json({ ok: false, reason: "expired", error: "expired" }, 409);
});
