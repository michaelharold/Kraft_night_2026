/**
 * AI job scoping + matching + dispatch.
 *
 * POST { action: "preview", rawDescription, location?: { lat, lng }, service? }
 *   → local AI (Ollama) builds the job breakdown (title, category, urgency, time, tools, skill level, tags, steps,
 *     photo requests, questions); a DRAFT is stored in MongoDB `jobs` (GeoJSON Point); the matching engine counts
 *     verified, available providers within 10 km with the skills and tools. Nobody is notified yet.
 *   ← 200 { jobId, scope, match: { count, online, offline, toolMatch, top[] } }
 *     503 { error: "ai_unavailable" } when Ollama cannot be reached (the UI offers the plain request instead)
 *
 * POST { action: "confirm", jobId, answers?: [{ question, answer }] }
 *   → DRAFT becomes OPEN with a 4-digit code; the live request is created (same id); matched providers are notified:
 *     app open → live dashboard update (SSE), app closed → SMS "Reply ACCEPT <code> to claim".
 *   ← 201 { request: RequestView, dispatch: { app, sms, toolMatch } }
 */
import { randomUUID } from "node:crypto";
import { getHelperSession } from "@/lib/auth";
import { emit } from "@/lib/events";
import { createDraft, getJob, openJob, recordMatches, registerJobMirror, type MatchedWorkerRecord } from "@/lib/jobs";
import { findMatchingWorkers } from "@/lib/matching";
import { ScopeError, scopeTask } from "@/lib/scope";
import { sendSms, tplScopedJob } from "@/lib/sms";
import { getStore } from "@/lib/store";
import { SKILL_LABELS, TOOL_LABELS, isService } from "@/lib/taxonomy";
import { isLatLng, json, jsonError, readJson, safe, text } from "@/lib/validate";
import { buildRequestView } from "@/lib/views";
import { createServiceRequest } from "@/lib/waves";
import type { HelpRequest, LatLng } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request) => {
  const s = getHelperSession(req);
  const account = s?.helperId ? await getStore().getHelper(s.helperId) : null;
  if (!account) return jsonError(401, "unauthenticated");
  const body = await readJson(req);
  if (!body.ok) return jsonError(400, "bad_json");
  const b = body.value;
  registerJobMirror(); // idempotent; instrumentation.ts normally did this at boot

  if (b.action === "preview") {
    const rawDescription = text(b.rawDescription, 1000);
    if (!rawDescription || rawDescription.length < 5) return jsonError(400, "rawDescription_invalid");
    if (b.location !== undefined && b.location !== null && !isLatLng(b.location)) return jsonError(400, "location_invalid");
    if (b.service !== undefined && !isService(b.service)) return jsonError(400, "service_invalid");
    const location: LatLng | null = isLatLng(b.location) ? b.location : account.location;
    if (!location) return jsonError(400, "location_required");
    let scope;
    try {
      scope = await scopeTask(rawDescription, isService(b.service) ? b.service : null);
    } catch (e) {
      if (e instanceof ScopeError) return jsonError(e.code === "ai_unavailable" ? 503 : 502, e.code, { detail: e.message });
      throw e;
    }
    try {
      const id = randomUUID();
      await createDraft({ id, requesterId: account.id, requesterPhone: account.phone, rawDescription, location, scope });
      const match = await findMatchingWorkers({ location, scope, excludeId: account.id });
      return json({
        jobId: id, scope, location,
        match: {
          count: match.workers.length, online: match.workers.filter((w) => w.online).length, offline: match.workers.filter((w) => !w.online).length,
          toolMatch: match.toolMatch,
          top: match.workers.slice(0, 5).map((w) => ({ name: w.name, distanceKm: w.distanceKm, rate: w.rate, online: w.online, toolsMatched: w.toolsMatched.length, toolsNeeded: scope.requiredTools.length })),
        },
      });
    } catch (e) {
      console.error("[scope-task] database", e);
      return jsonError(503, "database_unavailable");
    }
  }

  if (b.action === "confirm") {
    if (typeof b.jobId !== "string") return jsonError(400, "jobId_invalid");
    const answers = Array.isArray(b.answers)
      ? (b.answers as unknown[]).slice(0, 3).map((a) => (a && typeof a === "object" ? a as Record<string, unknown> : {}))
          .map((a) => ({ question: text(a.question, 120) ?? "", answer: text(a.answer, 200) ?? "" })).filter((a) => a.question && a.answer)
      : [];
    const job = await getJob(b.jobId);
    if (!job || job.requesterId !== account.id) return jsonError(404, "not_found");
    if (job.status !== "DRAFT") return jsonError(409, "already_sent");
    const location: LatLng | null = job.location ? { lat: job.location.coordinates[1], lng: job.location.coordinates[0] } : null;
    const scope = job.scope;
    const code = await openJob(job._id, answers);
    const request = await createServiceRequest({
      id: job._id, service: scope.category, description: job.rawDescription, location, account, notify: false,
      scope, shortCode: code, attachments: job.attachments, answers,
    });

    // Dual dispatch: the live dashboard AND a text, to everyone matched.
    //
    // This used to text only workers whose app was shut, on the theory that anyone looking at the screen has
    // already seen it. That theory is wrong in the one situation that matters: "online" here means an SSE stream
    // is open, which is true of a phone lying face-down in a toolbag. The person is not watching. A duplicate
    // text costs a fraction of a rupee; a missed job costs someone a day's work, so the text always goes.
    const match = location ? await findMatchingWorkers({ location, scope, excludeId: account.id }) : { workers: [], toolMatch: "none" as const };
    const now = new Date().toISOString();
    const records: MatchedWorkerRecord[] = [];
    for (const w of match.workers) {
      void sendSms(w.phone, tplScopedJob({ category: SKILL_LABELS[scope.category], title: scope.parsedTitle, minutes: scope.estimatedTimeMinutes,
        tools: scope.requiredTools.map((t) => TOOL_LABELS[t]), code, distanceKm: w.distanceKm }));
      records.push({ workerId: w.id, name: w.name, distanceKm: w.distanceKm, toolsMatched: w.toolsMatched, channel: w.online ? "sse" : "sms", notifiedAt: now });
    }
    await recordMatches(job._id, records, match.toolMatch);
    const updated = (await getStore().updateRequest(request.id, { aiMatchedWorkerIds: match.workers.map((w) => w.id) })) as HelpRequest;
    emit("request:updated", { request: updated }); // SSE: every open dashboard rebuilds; matched providers see "Matched for you"
    return json({ request: await buildRequestView(request.id), dispatch: { app: records.filter((r) => r.channel === "sse").length, sms: records.filter((r) => r.channel === "sms").length, toolMatch: match.toolMatch } }, 201);
  }

  return jsonError(400, "action_invalid");
});
