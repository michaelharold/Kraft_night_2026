/**
 * The customer's decision on one receipt: { action: "approve" | "reject" }.
 *
 * Only the person paying may call this — not the worker who filed the claim, not an admin — and only while the job
 * is still unpaid, because an approval is what puts the amount on the bill. Approving twice is the same approval;
 * reversing a decision is refused (409 already_decided) so the total cannot wobble while a payment is being set up.
 */
import { getHelperSession } from "@/lib/auth";
import { decideReceipt, type ReceiptFailReason } from "@/lib/receipts";
import { json, jsonError, readJson, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

const STATUS: Record<ReceiptFailReason, number> = {
  not_found: 404, not_worker: 403, not_customer: 403, job_not_active: 409,
  already_paid: 409, payment_in_progress: 409, too_many: 409, amount_required: 422, amount_invalid: 400, already_decided: 409,
};

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id, receiptId } = await params;
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "body_invalid");
  const action = body.value.action;
  if (action !== "approve" && action !== "reject") return jsonError(400, "action_invalid");
  const r = await decideReceipt({ requestId: id, receiptId, customerId: s.helperId, action });
  if (!r.ok) return jsonError(STATUS[r.reason], r.reason);
  return json({ reimbursement: r.reimbursement, approvedPaise: r.approvedPaise });
});
