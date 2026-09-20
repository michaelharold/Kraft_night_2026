import { isOps } from "@/lib/auth";
import { recentSms, smsConfigured } from "@/lib/sms";
import { sseResponse } from "@/lib/sse";
import { jsonError, safe } from "@/lib/validate";
import { buildOpsView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  if (!isOps(req)) return jsonError(401, "unauthenticated");
  return sseResponse(req, async () => ({ ...(await buildOpsView()), sms: recentSms(), smsSimulated: !smsConfigured() }), {
    "request:updated": undefined, "dispatch:created": undefined, "dispatch:updated": undefined, "helper:updated": undefined,
  }, 500);
});
