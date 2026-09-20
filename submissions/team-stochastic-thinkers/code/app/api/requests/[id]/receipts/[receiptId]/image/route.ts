/** The receipt photo itself: the customer paying for it and the worker who filed it. Nobody else, admins included. */
import { getHelperSession } from "@/lib/auth";
import { readReceipt } from "@/lib/files";
import { getReceiptFor } from "@/lib/receipts";
import { jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string; receiptId: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id, receiptId } = await params;
  const r = await getReceiptFor(id, receiptId, s.helperId);
  if (!r.ok) return jsonError(r.reason === "not_found" ? 404 : 403, r.reason);
  const bytes = await readReceipt(r.reimbursement.fileId);
  if (!bytes) return jsonError(404, "not_found");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": r.reimbursement.mime, "cache-control": "private, max-age=300" } });
});
