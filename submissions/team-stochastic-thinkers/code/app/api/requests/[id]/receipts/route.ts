/**
 * Receipts for parts the worker bought mid-job.
 *
 * POST (multipart: file, rupees?, note?) is for the ONE worker who accepted this job: the image is read by the
 * local vision model, and the claim is filed as "pending" — it changes nothing the customer owes until they
 * approve it on /api/requests/:id/receipts/:receiptId. `rupees` is the worker's own figure and overrides the
 * model's reading; with no vision model installed it is the only figure there is, which is why a missing amount
 * answers 422 amount_required instead of guessing one.
 *
 * GET lists the claims for the two people they concern: the customer paying and the worker who filed them.
 */
import { getHelperSession } from "@/lib/auth";
import { RECEIPT_MAX_BYTES, RECEIPT_TYPES } from "@/lib/files";
import { listReceipts, submitReceipt, type ReceiptFailReason } from "@/lib/receipts";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

const STATUS: Record<ReceiptFailReason, number> = {
  not_found: 404, not_worker: 403, not_customer: 403, job_not_active: 409,
  already_paid: 409, payment_in_progress: 409, too_many: 409, amount_required: 422, amount_invalid: 400, already_decided: 409,
};

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  let form: FormData;
  try { form = await req.formData(); } catch { return jsonError(400, "form_invalid"); }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "file_missing");
  if (!(RECEIPT_TYPES as readonly string[]).includes(file.type)) return jsonError(400, "file_type_invalid");
  if (file.size === 0 || file.size > RECEIPT_MAX_BYTES) return jsonError(400, "file_size_invalid");
  const rupees = form.get("rupees");
  const note = form.get("note");
  const r = await submitReceipt({
    requestId: id, workerId: s.helperId, bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, size: file.size,
    rupees: typeof rupees === "string" ? rupees : null, note: typeof note === "string" ? note : null,
  });
  // The reading travels with the refusal too: "we could not read a total" is what tells the worker to type one.
  if (!r.ok) return jsonError(STATUS[r.reason], r.reason, { analysis: r.analysis ?? null });
  return json({ reimbursement: r.reimbursement }, 201);
});

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const r = await listReceipts(id, s.helperId);
  if (!r.ok) return jsonError(r.reason === "not_found" ? 404 : 403, r.reason);
  return json(r.view);
});
