/** Twilio webhook: YES accepts, NO rejects, HELP <text> creates an SMS-in request (README §3, §10 rule 10). */
import { getStore } from "@/lib/store";
import { isOps } from "@/lib/auth";
import { matchLandmark } from "@/lib/landmarks";
import { normalizePhone, twiml } from "@/lib/sms";
import { accept, createHelpRequest, onReject } from "@/lib/waves";
import type { Dispatch } from "@/lib/types";

export const dynamic = "force-dynamic";

const reply = (t: string, status = 200) => new Response(twiml(t), { status, headers: { "content-type": "text/xml" } });
const newest = (ds: Dispatch[]) => [...ds].sort((a, b) => b.pingedAt.localeCompare(a.pingedAt) || a.id.localeCompare(b.id))[0];

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const fields: Record<string, string> = {};
    form.forEach((v, k) => { if (typeof v === "string") fields[k] = v; });
    if (process.env.TWILIO_VALIDATE_SIGNATURE === "1" && !isOps(req)) {
      const twilio = (await import("twilio")).default;
      const okSig = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN ?? "", req.headers.get("x-twilio-signature") ?? "",
        `${process.env.PUBLIC_BASE_URL ?? ""}/api/twilio/inbound`, fields);
      if (!okSig) return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const phone = normalizePhone(fields.From ?? "");
    const body = (fields.Body ?? "").trim().replace(/\s+/g, " ");
    if (!phone) return reply("RESQ: Could not read your number.");
    const store = getStore();
    const m = body.match(/^(yes|no|help)\b(.*)$/i);
    const cmd = m?.[1].toLowerCase();
    const join = `RESQ: This number is not registered. Open ${process.env.PUBLIC_BASE_URL ?? ""}/helper to join.`;

    if (cmd === "yes" || cmd === "no") {
      const helper = await store.getHelperByPhone(phone);
      if (!helper) return reply(join);
      const d = newest(await store.listPingedForHelper(helper.id));
      if (cmd === "no") { if (d) await onReject(d.id, "sms"); return reply("RESQ: Skipped. Thank you."); }
      if (!d) return reply("RESQ: No open request for you right now.");
      const r = await accept(d.id, "sms");
      if (r.ok) return reply(`RESQ: You're matched. Map: ${r.mapsUrl ?? "location unknown"}. Call the requester: ${r.requesterPhone ?? "via app"}.`);
      return reply(r.reason === "tier_required" ? "RESQ: That job needs a Certified Pro badge."
        : r.reason === "busy" ? "RESQ: Finish your current job first, then reply YES to new requests."
        : r.reason === "already_matched" ? "RESQ: Sorry, that request was already taken."
        : r.reason === "expired" ? "RESQ: Sorry, that request has expired." : "RESQ: No open request for you right now.");
    }
    if (cmd === "help") {
      const text = (m?.[2] ?? "").trim().slice(0, 1000);
      if (text.length < 3) return reply("RESQ: Tell us what happened and where, e.g. HELP trapped near TKMCE hostel");
      const lm = matchLandmark(text);
      await createHelpRequest({
        requesterId: `sms:${phone}`, requesterPhone: phone, requesterHelperId: (await store.getHelperByPhone(phone))?.id ?? null,
        description: text, location: lm?.location ?? null, locationSource: lm ? "landmark" : "none", landmark: lm?.name ?? null, channel: "sms",
      });
      return reply(lm ? `RESQ: Got it. Finding helpers near ${lm.name}. Call 112 if life is at risk.`
        : "RESQ: Got it. We could not place you. A coordinator will call. Call 112 now if life is at risk.");
    }
    return reply("RESQ: Reply YES or NO to a request, or HELP <what happened, where>.");
  } catch (e) {
    console.error("[twilio]", e);
    return reply("RESQ: Something went wrong. Call 112 if life is at risk.");
  }
}
