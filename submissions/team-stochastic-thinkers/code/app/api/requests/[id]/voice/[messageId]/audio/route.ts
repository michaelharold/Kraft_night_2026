/**
 * The spoken translation of one turn, as WAV. Only the two people on the job may fetch it — a voice note is a
 * private conversation, and a message id is guessable enough that "unlisted" is not a control.
 */
import { getHelperSession } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { jsonError, safe } from "@/lib/validate";
import { getSpokenAudio, getVoiceMessage } from "@/lib/voice";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) => {
  const s = getHelperSession(req);
  if (!s?.helperId) return jsonError(401, "unauthenticated");
  const { id, messageId } = await params;

  const r = await getStore().getRequest(id);
  if (!r) return jsonError(404, "not_found");
  if (r.requesterHelperId !== s.helperId && r.matchedHelperId !== s.helperId) return jsonError(404, "not_found");

  const msg = getVoiceMessage(messageId);
  if (!msg || msg.requestId !== id) return jsonError(404, "not_found");
  const wav = getSpokenAudio(messageId);
  if (!wav) return jsonError(404, "no_audio");

  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: { "content-type": "audio/wav", "content-length": String(wav.length), "cache-control": "private, max-age=600" },
  });
});
