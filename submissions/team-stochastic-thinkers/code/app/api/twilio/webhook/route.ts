/**
 * Twilio webhook for offline providers. "ACCEPT 1234" claims the open job with that code:
 *   1. parse Body (case-insensitive, "ACCEPT 1234" / "accept #1234") and From (the worker's phone);
 *   2. find the OPEN job in MongoDB `jobs` by its 4-digit code;
 *   3. claim it atomically through the live engine (same lock as an in-app Accept, so app and SMS can never both win)
 *      and mark it ASSIGNED in MongoDB with a conditional update (status must still be OPEN);
 *   4. reply with TwiML: the job details, or why it could not be claimed.
 * Anything else (YES / NO / HELP …) is passed to the existing SMS handler, because a Twilio number has one webhook.
 */
import { getStore } from "@/lib/store";
import { isOps } from "@/lib/auth";
import { findOpenByCode, jobsCollection, markAssigned, registerJobMirror, setAssignedVia } from "@/lib/jobs";
import { mapsUrl, normalizePhone, twiml } from "@/lib/sms";
import { SKILL_LABELS, TOOL_LABELS } from "@/lib/taxonomy";
import { claim } from "@/lib/waves";
import { POST as legacyInbound } from "../inbound/route";

export const dynamic = "force-dynamic";
const ACCEPT = /^\s*accept\s*#?\s*(\d{4})\b/i;
const reply = (t: string) => new Response(twiml(t), { status: 200, headers: { "content-type": "text/xml" } });

export async function POST(req: Request) {
  const raw = await req.text(); // read once so it can be re-sent to the legacy handler
  const fields = Object.fromEntries(new URLSearchParams(raw));
  const body = (fields.Body ?? "").trim();
  const m = body.match(ACCEPT);
  if (!m) {
    return legacyInbound(new Request(req.url, { method: "POST", headers: req.headers, body: raw }));
  }
  try {
    if (process.env.TWILIO_VALIDATE_SIGNATURE === "1" && !isOps(req)) {
      const twilio = (await import("twilio")).default;
      const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN ?? "", req.headers.get("x-twilio-signature") ?? "",
        `${process.env.PUBLIC_BASE_URL ?? ""}/api/twilio/webhook`, fields);
      if (!valid) return Response.json({ error: "forbidden" }, { status: 403 });
    }
    registerJobMirror();
    const phone = normalizePhone(fields.From ?? "");
    const code = m[1];
    const worker = phone ? await getStore().getHelperByPhone(phone) : null;
    if (!worker) return reply(`Sahaya: This number is not registered as a provider. Sign up in the Sahaya app first.`);
    const job = await findOpenByCode(code);
    // No open job with that code and already-taken are the same story to the worker: they answered a job that is
    // gone. Say so warmly — a bare error reads as a rejection of them, when all they did was arrive second.
    if (!job) return reply(`Sahaya: Job ${code} was taken a few minutes ago - nothing more to do. Thanks for replying; we will text you the next one near you.`);
    const r = await claim(job._id, worker.id);
    if (!r.ok && r.reason === "not_found") {
      await (await jobsCollection()).updateOne({ _id: job._id, status: "OPEN" }, { $set: { status: "CANCELLED", updatedAt: new Date() } });
      return reply(`Sahaya: Job ${code} is no longer open - the customer closed it. Thanks for replying; we will text you the next one near you.`);
    }
    if (!r.ok) {
      const why = r.reason === "already_matched" ? `Job ${code} was taken just before your reply - nothing more to do. Thanks for being quick; we will text you the next one near you.`
        : r.reason === "busy" ? `Finish your current job first, then you can accept ${code}.`
        : r.reason === "service_mismatch" ? `Job ${code} needs a ${SKILL_LABELS[job.scope.category]}; your profile doesn't offer that service.`
        : r.reason === "own_request" ? `That is your own request.` : `Job ${code} can't be accepted right now.`;
      return reply(`Sahaya: ${why}`);
    }
    // The mirror has almost certainly written the ASSIGNED row already (it runs inside claim()), so this is
    // usually a no-op and the following line is what actually records the channel. Both are kept: the order
    // of the two writers is an implementation detail that should not decide whether the row exists.
    await markAssigned(job._id, { id: worker.id, phone: worker.phone }, "sms");
    await setAssignedVia(job._id, "sms");
    const req2 = r.request;
    const tools = job.scope.requiredTools.map((t) => TOOL_LABELS[t]).join(", ") || "standard kit";
    const answers = (req2.answers ?? []).map((a) => `${a.question} ${a.answer}`).join("; ");
    const where = req2.location ? mapsUrl(req2.location) : "ask the customer";
    return reply([
      `Sahaya: Job ${code} is yours: ${job.scope.parsedTitle}.`,
      `Customer: ${req2.requesterName ?? "customer"} ${req2.requesterPhone ?? ""}.`,
      `Bring: ${tools}. Est ${job.scope.estimatedTimeMinutes} min.`,
      answers ? `Details: ${answers}.` : "",
      `Map: ${where}`,
      (req2.attachments?.length ?? 0) > 0 ? `${req2.attachments!.length} photo(s) in the Sahaya app.` : "",
    ].filter(Boolean).join(" "));
  } catch (e) {
    console.error("[twilio/webhook]", e);
    return reply("Sahaya: Something went wrong. Please try again or accept in the app.");
  }
}
