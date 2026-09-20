/**
 * POST /api/requests/:id/charge — the worker names their final charge for the work, which is what turns a finished
 * job into a bill. Only the matched worker may set it, only while the job is theirs and unpaid, and only in rupees
 * a human typed: parseRupeesToPaise takes "750", "750.50" or "₹1,200" and refuses everything else rather than
 * guessing, because a guess here is somebody's money.
 */
import { getHelperSession } from "@/lib/auth";
import { MAX_SERVICE_PAISE, MIN_SERVICE_PAISE, formatPaise, parseRupeesToPaise } from "@/lib/money";
import { setServiceCharge, type ChargeResult } from "@/lib/payments";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
type Reason = Extract<ChargeResult, { ok: false }>["reason"];
const STATUS: Record<Reason, number> = { not_found: 404, not_service: 409, forbidden: 403, wrong_status: 409, already_paid: 409, amount_invalid: 400 };

export const POST = safe(async (req: Request, { params }: Ctx) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");

  const servicePaise = parseRupeesToPaise(body.value.rupees);
  if (servicePaise === null) return jsonError(400, "amount_invalid", { detail: "Enter the amount in rupees, for example 750 or 750.50." });
  if (servicePaise < MIN_SERVICE_PAISE || servicePaise > MAX_SERVICE_PAISE) {
    return jsonError(400, "amount_out_of_range", { detail: `The charge must be between ${formatPaise(MIN_SERVICE_PAISE)} and ${formatPaise(MAX_SERVICE_PAISE)}.`, minPaise: MIN_SERVICE_PAISE, maxPaise: MAX_SERVICE_PAISE });
  }

  const res = await setServiceCharge(id, s.helperId, servicePaise);
  if (!res.ok) return jsonError(STATUS[res.reason], res.reason);
  return json({ ok: true, servicePaise, servicePretty: formatPaise(servicePaise), bill: res.bill });
});
