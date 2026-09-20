/**
 * MongoDB `jobs` collection: the durable record of every AI-scoped request.
 *   { _id (= request id), status DRAFT|OPEN|ASSIGNED|COMPLETED|CANCELLED, shortCode (4 digits, unique among OPEN
 *     jobs, used in "ACCEPT 1234"), requesterId, requesterPhone, rawDescription, location: GeoJSON Point [lng, lat],
 *     scope (AI breakdown), attachments, answers, matchedWorkers [{ workerId, channel sse|sms, … }],
 *     assignedWorkerId, assignedWorkerPhone, assignedVia, createdAt, updatedAt, expiresAt (drafts only, TTL 1 h) }
 * The live request lifecycle stays in the in-process engine (lib/waves.ts, atomic under a lock); registerJobMirror()
 * copies every status change here with conditional updates, so MongoDB always reflects who got the job.
 */
import { randomInt } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "./mongodb";
import { on } from "./events";
import { getStore } from "./store";
import type { HelpRequest, JobPhoto, LatLng, TaskScope } from "./types";

export type JobStatus = "DRAFT" | "OPEN" | "ASSIGNED" | "COMPLETED" | "CANCELLED";
export type MatchedWorkerRecord = { workerId: string; name: string; distanceKm: number; toolsMatched: string[]; channel: "sse" | "sms"; notifiedAt: string };
export type JobDoc = {
  _id: string; status: JobStatus; shortCode: string | null; requesterId: string; requesterPhone: string;
  rawDescription: string; location: { type: "Point"; coordinates: [number, number] } | null; scope: TaskScope;
  attachments: JobPhoto[]; answers: { question: string; answer: string }[]; matchedWorkers: MatchedWorkerRecord[];
  toolMatch: "all" | "any" | "skills_only" | "none" | null;
  assignedWorkerId: string | null; assignedWorkerPhone: string | null; assignedVia: "app" | "sms" | null;
  createdAt: Date; updatedAt: Date; expiresAt?: Date;
};

const g = globalThis as unknown as { __resq_jobs_ready?: Promise<Collection<JobDoc>>; __resq_jobs_mirror?: boolean };

export function jobsCollection(): Promise<Collection<JobDoc>> {
  g.__resq_jobs_ready ??= (async () => {
    const col = (await getDb()).collection<JobDoc>("jobs");
    await Promise.all([
      col.createIndex({ location: "2dsphere" }, { name: "jobs_geo" }),
      col.createIndex({ shortCode: 1 }, { name: "open_shortcode_unique", unique: true, partialFilterExpression: { status: "OPEN" } }),
      col.createIndex({ status: 1, createdAt: -1 }, { name: "jobs_status_recent" }),
      col.createIndex({ expiresAt: 1 }, { name: "drafts_ttl", expireAfterSeconds: 0 }),
    ]);
    return col;
  })().catch((e) => { g.__resq_jobs_ready = undefined; throw e; });
  return g.__resq_jobs_ready;
}

export const toPoint = (p: LatLng | null) => (p ? { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] } : null);

export async function createDraft(d: { id: string; requesterId: string; requesterPhone: string; rawDescription: string; location: LatLng | null; scope: TaskScope }): Promise<JobDoc> {
  const now = new Date();
  const doc: JobDoc = {
    _id: d.id, status: "DRAFT", shortCode: null, requesterId: d.requesterId, requesterPhone: d.requesterPhone,
    rawDescription: d.rawDescription, location: toPoint(d.location), scope: d.scope, attachments: [], answers: [], matchedWorkers: [],
    toolMatch: null, assignedWorkerId: null, assignedWorkerPhone: null, assignedVia: null, createdAt: now, updatedAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
  };
  await (await jobsCollection()).insertOne(doc);
  return doc;
}

export async function getJob(id: string): Promise<JobDoc | null> {
  return (await jobsCollection()).findOne({ _id: id });
}

export async function addPhoto(id: string, photo: JobPhoto): Promise<boolean> {
  const r = await (await jobsCollection()).updateOne({ _id: id, status: "DRAFT", "attachments.3": { $exists: false } }, { $push: { attachments: photo }, $set: { updatedAt: new Date() } });
  return r.modifiedCount === 1;
}

/** DRAFT → OPEN with a fresh 4-digit code (unique among open jobs thanks to the partial unique index). */
export async function openJob(id: string, answers: { question: string; answer: string }[]): Promise<string> {
  const col = await jobsCollection();
  for (let i = 0; i < 25; i++) {
    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    try {
      const r = await col.updateOne({ _id: id, status: "DRAFT" }, { $set: { status: "OPEN", shortCode: code, answers, updatedAt: new Date() }, $unset: { expiresAt: "" } });
      if (r.matchedCount === 0) throw new Error("job is not a draft any more");
      return code;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) continue; // code already used by another open job: try another
      throw e;
    }
  }
  throw new Error("could not allocate a job code");
}

export async function recordMatches(id: string, matched: MatchedWorkerRecord[], toolMatch: JobDoc["toolMatch"]): Promise<void> {
  await (await jobsCollection()).updateOne({ _id: id }, { $set: { matchedWorkers: matched, toolMatch, updatedAt: new Date() } });
}

export async function findOpenByCode(code: string): Promise<JobDoc | null> {
  return (await jobsCollection()).findOne({ shortCode: code, status: "OPEN" });
}

/** Atomic in MongoDB too: only an OPEN job can become ASSIGNED, so two claims can never both win here. */
export async function markAssigned(id: string, worker: { id: string; phone: string }, via: "app" | "sms"): Promise<boolean> {
  const r = await (await jobsCollection()).updateOne({ _id: id, status: "OPEN" },
    { $set: { status: "ASSIGNED", assignedWorkerId: worker.id, assignedWorkerPhone: worker.phone, assignedVia: via, updatedAt: new Date() } });
  return r.modifiedCount === 1;
}

/**
 * Record HOW a job was accepted, independently of who wrote the ASSIGNED row first.
 *
 * The mirror below runs synchronously off emit("request:updated") inside acceptLocked, so it reaches MongoDB
 * BEFORE claim() has even returned to the SMS webhook. Whoever loses that race would otherwise have their channel
 * silently discarded, and every SMS acceptance would be filed as "app" — which is exactly backwards for the one
 * statistic this field exists to report.
 */
export async function setAssignedVia(id: string, via: "app" | "sms"): Promise<void> {
  await (await jobsCollection()).updateOne({ _id: id, status: "ASSIGNED" }, { $set: { assignedVia: via, updatedAt: new Date() } });
}

/** Keep MongoDB in step with the live engine (accepted in the app, completed, cancelled). Registered once per process. */
export function registerJobMirror(): void {
  if (g.__resq_jobs_mirror) return;
  g.__resq_jobs_mirror = true;
  // Live requests are held in memory: after a server restart, jobs still OPEN in MongoDB can no longer be accepted.
  void jobsCollection()
    .then((col) => col.updateMany({ status: "OPEN" }, { $set: { status: "CANCELLED", updatedAt: new Date() } }))
    .then((r) => { if (r.modifiedCount) console.log(`[jobs] closed ${r.modifiedCount} open job(s) left over from before the restart`); })
    .catch((e) => console.error("[jobs] startup cleanup failed", e));
  on("request:updated", async ({ request: r }: { request: HelpRequest }) => {
    if (!r.shortCode) return; // not an AI-scoped job
    try {
      if (r.status === "matched" && r.matchedHelperId) {
        const h = await getStore().getHelper(r.matchedHelperId);
        // "app" is the assumption; an SMS acceptance corrects it with setAssignedVia() once claim() returns.
        if (h) await markAssigned(r.id, { id: h.id, phone: h.phone }, "app");
      } else if (r.status === "resolved" || r.status === "cancelled") {
        await (await jobsCollection()).updateOne({ _id: r.id, status: { $in: ["OPEN", "ASSIGNED"] } }, { $set: { status: r.status === "resolved" ? "COMPLETED" : "CANCELLED", updatedAt: new Date() } });
      }
    } catch (e) {
      console.error("[jobs] mirror failed", e);
    }
  });
}
