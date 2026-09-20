/** Authorities: people waiting for ID verification (pending first), then recently reviewed. */
import { getOps } from "@/lib/authority";
import { getStore } from "@/lib/store";
import { json, jsonError, safe } from "@/lib/validate";

export const dynamic = "force-dynamic";
const ORDER = { pending: 0, rejected: 1, verified: 2 } as const;

export const GET = safe(async (req: Request) => {
  if (!getOps(req)) return jsonError(401, "unauthenticated");
  const people = (await getStore().listHelpers())
    .filter((h) => h.idProof && h.idProof.fileId) // uploaded documents only (seeded demo providers have none)
    .sort((a, b) => ORDER[a.idProof!.status] - ORDER[b.idProof!.status] || b.idProof!.uploadedAt.localeCompare(a.idProof!.uploadedAt))
    .map((h) => ({ id: h.id, name: h.name, phone: h.phone, skills: h.skills, rates: h.rates ?? {}, profile: h.profile ?? null, idProof: h.idProof }));
  return json({ people });
});
