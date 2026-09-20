import { isOps } from "@/lib/auth";
import { recentSms, smsConfigured } from "@/lib/sms";
import { json, jsonError, safe } from "@/lib/validate";
import { buildOpsView } from "@/lib/views";
import { tickDueRequests } from "@/lib/waves";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  if (!isOps(req)) return jsonError(401, "unauthenticated");
  await tickDueRequests();
  return json({ ...(await buildOpsView()), sms: recentSms(), smsSimulated: !smsConfigured() });
});
