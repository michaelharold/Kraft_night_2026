/**
 * The in-app half of the voice relay.
 *
 * POST — someone on the job says something. The browser has already turned speech into text with the Web Speech
 * API (components/VoiceMic.tsx), in whatever language they chose, so what arrives here is text plus a language
 * tag. The server translates it for the other party and then decides how to deliver it:
 *
 *   - the other party has the app open  -> nothing to do. The message lands on their screen over SSE, in their
 *     own language, and their phone stays quiet.
 *   - the other party is NOT in the app -> Sahaya calls them and reads it out. This is the case the whole feature
 *     exists for: the plumber who is under a sink with a phone in his pocket still hears "bring a 15 mm elbow".
 *
 * GET — the thread so far. Visible only to the two people on the job; a voice note is a private conversation, not
 * a public log, and ops can see that messages exist without reading them.
 */
import { getHelperSession } from "@/lib/auth";
import { isLanguage, languageOf } from "@/lib/languages";
import { isAppOnline } from "@/lib/presence";
import { getStore } from "@/lib/store";
import { json, jsonError, readJson, safe } from "@/lib/validate";
import { captureVoiceMessage, deliverByCall, listVoiceMessages } from "@/lib/voice";

export const dynamic = "force-dynamic";

/** The two people on a job, and which side the caller is. Anyone else gets a 404 rather than a 403: a stranger
 *  should not be able to learn that a job exists by probing ids. */
async function partyTo(requestId: string, helperId: string | null) {
  if (!helperId) return null;
  const r = await getStore().getRequest(requestId);
  if (!r) return null;
  if (r.requesterHelperId === helperId) return { request: r, role: "requester" as const };
  if (r.matchedHelperId === helperId) return { request: r, role: "helper" as const };
  return null;
}

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const party = await partyTo(id, s.helperId);
  if (!party) return jsonError(404, "not_found");
  return json({ messages: listVoiceMessages(id), me: party.role });
});

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id } = await params;
  const party = await partyTo(id, s.helperId);
  if (!party) return jsonError(404, "not_found");

  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const text = typeof body.value.text === "string" ? body.value.text.trim() : "";
  if (!text) return jsonError(400, "text_required");

  // The language they spoke in. Falls back to the one on their account rather than to whatever the client claims.
  const me = await getStore().getHelper(s.helperId);
  const sourceLang = isLanguage(body.value.lang) ? body.value.lang : languageOf(me?.language).code;

  const captured = await captureVoiceMessage({
    requestId: id, fromRole: party.role, fromHelperId: s.helperId, fromPhone: me?.phone ?? null,
    sourceText: text, sourceLang, channel: "app",
  });
  if (!captured.ok) return jsonError(captured.reason === "no_counterpart" ? 409 : 400, captured.reason);

  // Only ring them if they are not already looking at the screen this message just landed on.
  const recipientOnline = captured.message.toHelperId ? isAppOnline(captured.message.toHelperId) : false;
  if (!recipientOnline) void deliverByCall(captured.message.id);

  return json({ message: captured.message, deliveredBy: recipientOnline ? "app" : "call" }, 201);
});
