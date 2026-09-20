/** Authorities: view a person's ID proof (GET) and approve or reject it (POST { decision, note? }). */
import { audit, getOps } from "@/lib/authority";
import { emit } from "@/lib/events";
import { readIdProof } from "@/lib/files";
import { sendSms } from "@/lib/sms";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe, text } from "@/lib/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = safe(async (req: Request, { params }: Ctx) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const h = await getStore().getHelper(id);
  if (!h?.idProof?.fileId) return jsonError(404, "not_found");
  const bytes = await readIdProof(h.idProof.fileId);
  if (!bytes) return jsonError(404, "not_found");
  await audit(who, "viewed_id_proof", `${h.name} (${h.phone})`);
  return new Response(new Uint8Array(bytes), { headers: { "content-type": h.idProof.mime, "cache-control": "private, no-store" } });
});

export const POST = safe(async (req: Request, { params }: Ctx) => {
  const who = getOps(req);
  if (!who) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const decision = body.value.decision;
  if (decision !== "verified" && decision !== "rejected") return jsonError(400, "decision_invalid");
  const note = body.value.note === undefined || body.value.note === "" ? null : text(body.value.note, 200);
  const store = getStore();
  const h = await store.getHelper(id);
  if (!h?.idProof) return jsonError(404, "not_found");
  const helper = await store.upsertHelper({ ...h, idProof: { ...h.idProof, status: decision, reviewedBy: who.user, reviewedAt: new Date().toISOString(), note } });
  emit("helper:updated", { helper });
  await audit(who, decision === "verified" ? "id_verified" : "id_rejected", `${h.name} (${h.phone})${note ? `: ${note}` : ""}`);
  void sendSms(h.phone, decision === "verified"
    ? "RESQ: Your ID is verified. Your profile now shows the Verified badge."
    : `RESQ: Your ID could not be verified${note ? ` (${note.slice(0, 60)})` : ""}. Please upload a clearer document in the app.`);
  return json({ ok: true, idProof: helper.idProof });
});
