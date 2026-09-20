/** A job photo: visible to the customer, the worker who accepted the job, and admins. Nobody else. */
import { getHelperSession } from "@/lib/auth";
import { getOps } from "@/lib/authority";
import { readJobPhoto } from "@/lib/files";
import { getJob } from "@/lib/jobs";
import { getStore } from "@/lib/store";
import { jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) => {
  const { id, photoId } = await params;
  const job = await getJob(id);
  const photo = job?.attachments.find((p) => p.id === photoId);
  if (!job || !photo) return jsonError(404, "not_found");
  const s = getHelperSession(req);
  const request = await getStore().getRequest(id);
  const allowed = !!getOps(req) || (!!s?.helperId && (s.helperId === job.requesterId || s.helperId === request?.matchedHelperId || s.helperId === job.assignedWorkerId));
  if (!allowed) return jsonError(s ? 403 : 401, s ? "forbidden" : "unauthenticated");
  const bytes = await readJobPhoto(photo.fileId);
  if (!bytes) return jsonError(404, "not_found");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": photo.mime, "cache-control": "private, max-age=300" } });
});
