import { getStore } from "@/lib/store";
import { hasIdentity, requestAccess } from "@/lib/access";
import { isStars, json, jsonError, readJson, safe } from "@/lib/validate";
import { cancel, rate, resolve } from "@/lib/waves";
import { buildRequestView } from "@/lib/views";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = safe(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const r = await getStore().getRequest(id);
  if (!r) return jsonError(404, "not_found");
  if (!requestAccess(req, r)) return jsonError(hasIdentity(req) ? 403 : 401, hasIdentity(req) ? "forbidden" : "unauthenticated");
  return json(await buildRequestView(id));
});

export const PATCH = safe(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const r = await getStore().getRequest(id);
  if (!r) return jsonError(404, "not_found");
  const who = requestAccess(req, r);
  if (!who) return jsonError(hasIdentity(req) ? 403 : 401, hasIdentity(req) ? "forbidden" : "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const action = body.value.action;
  let res;
  if (action === "cancel") {
    if (who === "helper") return jsonError(403, "forbidden");
    res = await cancel(id);
  } else if (action === "resolve") {
    res = await resolve(id);
  } else if (action === "rate") {
    if (who === "helper") return jsonError(403, "forbidden");
    if (!isStars(body.value.stars)) return jsonError(400, "stars_invalid");
    res = await rate(id, body.value.stars);
  } else return jsonError(400, "action_invalid");
  if (!res.ok) return jsonError(res.reason === "not_found" ? 404 : 409, res.reason);
  return json(await buildRequestView(id));
});
