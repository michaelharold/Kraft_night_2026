/** Upload (POST multipart "file") or view (GET) your own ID proof. A new upload resets verification to "pending". */
import { getHelperSession } from "@/lib/auth";
import { emit } from "@/lib/events";
import { ID_PROOF_MAX_BYTES, ID_PROOF_TYPES, readIdProof, saveIdProof } from "@/lib/files";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  let form: FormData;
  try { form = await req.formData(); } catch { return jsonError(400, "form_invalid"); }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "file_missing");
  if (!(ID_PROOF_TYPES as readonly string[]).includes(file.type)) return jsonError(400, "file_type_invalid", { allowed: ID_PROOF_TYPES });
  if (file.size === 0 || file.size > ID_PROOF_MAX_BYTES) return jsonError(400, "file_size_invalid", { maxBytes: ID_PROOF_MAX_BYTES });
  const store = getStore();
  const me = await store.getHelper(s.helperId);
  if (!me) return jsonError(404, "not_found");
  const fileName = (file.name || "id-proof").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
  const fileId = await saveIdProof(Buffer.from(await file.arrayBuffer()), { ownerId: me.id, fileName, mime: file.type });
  const fresh = (await store.getHelper(me.id)) ?? me;
  const helper = await store.upsertHelper({ ...fresh, idProof: { fileId, fileName, mime: file.type, size: file.size, uploadedAt: new Date().toISOString(), status: "pending", reviewedBy: null, reviewedAt: null, note: null } });
  emit("helper:updated", { helper });
  return json({ ok: true, idProof: helper.idProof }, 201);
});

export const GET = safe(async (req: Request) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const me = await getStore().getHelper(s.helperId);
  if (!me?.idProof?.fileId) return jsonError(404, "not_found");
  const bytes = await readIdProof(me.idProof.fileId);
  if (!bytes) return jsonError(404, "not_found");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": me.idProof.mime, "cache-control": "private, no-store" } });
});
