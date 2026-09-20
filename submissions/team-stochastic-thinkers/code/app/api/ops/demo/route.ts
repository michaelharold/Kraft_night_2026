/** Demo controls for the coordinator: seeded helpers on/off, reset open requests. */
import { getStore } from "@/lib/store";
import { isOps } from "@/lib/auth";
import { emit } from "@/lib/events";
import { json, jsonError, readJson, safe } from "@/lib/validate";
import { cancel } from "@/lib/waves";

export const dynamic = "force-dynamic";
const SEEDED = /^seed-helper-/;

export const POST = safe(async (req: Request) => {
  if (!isOps(req)) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const store = getStore();
  const action = body.value.action;
  if (action === "seeded_on" || action === "seeded_off") {
    let n = 0;
    for (const h of await store.listHelpers()) {
      if (!SEEDED.test(h.id)) continue;
      const u = await store.setOnDuty(h.id, action === "seeded_on");
      if (u) { emit("helper:updated", { helper: u }); n++; }
    }
    return json({ ok: true, helpers: n });
  }
  if (action === "reset") {
    let n = 0;
    for (const r of await store.listOpenRequests()) if ((await cancel(r.id)).ok) n++;
    return json({ ok: true, cancelled: n });
  }
  return jsonError(400, "action_invalid");
});
