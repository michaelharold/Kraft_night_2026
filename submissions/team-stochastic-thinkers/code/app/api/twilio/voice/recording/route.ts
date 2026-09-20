/**
 * Twilio has finished writing the recording of a call and is telling us where it lives.
 *
 * This is decoration, not the mechanism: the transcript was already translated and delivered while the caller was
 * still speaking. The audio is here so the recipient can play the actual voice when a transcript looks wrong — a
 * misheard house number is worth hearing for yourself. Failures here are logged and dropped.
 */
import { attachRecording } from "@/lib/voice";
import { readFields } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const read = await readFields(req, "/api/twilio/voice/recording");
  if (!read.ok) return new Response("forbidden", { status: 403 });
  try {
    const id = new URL(req.url).searchParams.get("m") ?? "";
    const url = read.fields.RecordingUrl;
    if (id && url) {
      const secs = Number(read.fields.RecordingDuration);
      attachRecording(id, url, Number.isFinite(secs) ? secs : null);
    }
  } catch (e) {
    console.error("[voice] recording callback failed:", e);
  }
  return new Response("", { status: 204 });
}
