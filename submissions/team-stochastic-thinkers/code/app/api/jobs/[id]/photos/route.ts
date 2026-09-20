/** The customer adds a photo (multipart: file, label, angle) to their draft job before sending it. Max 4. */
import { randomUUID } from "node:crypto";
import { getHelperSession } from "@/lib/auth";
import { JOB_PHOTO_MAX_BYTES, JOB_PHOTO_TYPES, saveJobPhoto } from "@/lib/files";
import { addPhoto, getJob } from "@/lib/jobs";
import { json, jsonError, safe } from "@/lib/validate";
import type { JobPhoto } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.requesterId !== s.helperId) return jsonError(404, "not_found");
  if (job.status !== "DRAFT") return jsonError(409, "already_sent");
  if (job.attachments.length >= 4) return jsonError(409, "too_many_photos");
  let form: FormData;
  try { form = await req.formData(); } catch { return jsonError(400, "form_invalid"); }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "file_missing");
  if (!(JOB_PHOTO_TYPES as readonly string[]).includes(file.type)) return jsonError(400, "file_type_invalid");
  if (file.size === 0 || file.size > JOB_PHOTO_MAX_BYTES) return jsonError(400, "file_size_invalid");
  const label = String(form.get("label") ?? "Photo").slice(0, 80);
  const angle = String(form.get("angle") ?? "").slice(0, 80);
  const fileId = await saveJobPhoto(Buffer.from(await file.arrayBuffer()), { jobId: id, label, mime: file.type });
  const photo: JobPhoto = { id: randomUUID(), fileId, label, angle, mime: file.type, size: file.size, uploadedAt: new Date().toISOString() };
  if (!(await addPhoto(id, photo))) return jsonError(409, "too_many_photos");
  return json({ photo }, 201);
});
