import { SESSION_COOKIE, isSecureRequest, serializeCookie } from "@/lib/session";
import { json } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return json({ ok: true }, 200, { "set-cookie": serializeCookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure: isSecureRequest(req) }) });
}
