/**
 * Durable storage for registered-user data. Live dispatch state (requests, dispatches, OTPs) stays in memory so
 * accept-once stays atomic; everything a person registers is persisted through one of these backends:
 *   - MongoPersistence (MONGODB_URI set): database `resq` (MONGODB_DB), collections users, authorities,
 *     user_locations, zones, audit_log, payments, reimbursements — write-through of changed documents.
 *   - JsonFilePersistence (fallback): .data/accounts.json.
 *
 * Payments and reimbursements are durable even though the requests they belong to are not: a record of money that
 * changed hands is worthless if a restart can erase it, and a settled payment is the only evidence the worker was
 * credited. Nothing here ever deletes one either — a wrong payment is corrected by writing another record.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry, Authority, Helper, Payment, Reimbursement, UserLocation, Zone } from "../types";
import { getDb } from "../mongo";

export type Snapshot = { helpers: Helper[]; locations: UserLocation[]; zones: Zone[]; authorities: Authority[]; audit: AuditEntry[];
  payments: Payment[]; reimbursements: Reimbursement[] };
export type Changes = {
  helpers: Helper[]; locations: UserLocation[]; deletedLocations: string[]; zones: Zone[]; authorities: Authority[]; audit: AuditEntry[];
  payments: Payment[]; reimbursements: Reimbursement[];
  full: Snapshot; // for backends that rewrite everything
};
export interface Persistence {
  readonly name: string;
  load(): Promise<Partial<Snapshot> | null>;
  flush(c: Changes): Promise<void>;
}

// ── JSON file ────────────────────────────────────────────────────────────────────────────────────────────────
export class JsonFilePersistence implements Persistence {
  readonly name: string;
  constructor(private path: string) { this.name = `file ${path}`; }
  async load() {
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Partial<Snapshot>; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[store] could not read", this.path, e); return null; }
  }
  async flush(c: Changes) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify({ savedAt: new Date().toISOString(), ...c.full }, null, 2));
    renameSync(this.path + ".tmp", this.path); // atomic replace
  }
}

// ── MongoDB ──────────────────────────────────────────────────────────────────────────────────────────────────
type Doc = Record<string, unknown> & { _id: string };
const strip = <T,>(d: Doc | null): T => { const { _id, geo, ...rest } = (d ?? {}) as Doc; void _id; void geo; return rest as T; };
const point = (p: { lat: number; lng: number } | null | undefined) => (p ? { type: "Point", coordinates: [p.lng, p.lat] } : null);

export class MongoPersistence implements Persistence {
  readonly name: string;
  constructor(private dbName: string, private importFrom: string | null) { this.name = `MongoDB ${dbName}`; }

  private indexed: Promise<void> | null = null;
  private async db() {
    const db = await getDb();
    this.indexed ??= Promise.all([
      db.collection("users").createIndex({ phone: 1 }, { unique: true, name: "phone_unique" }),
      db.collection("users").createIndex({ geo: "2dsphere" }, { name: "users_geo", sparse: true }),
      db.collection("users").createIndex({ skills: 1 }, { name: "users_skills" }),
      db.collection("user_locations").createIndex({ geo: "2dsphere" }, { name: "locations_geo" }),
      db.collection("user_locations").createIndex({ updatedAt: -1 }, { name: "locations_recent" }),
      db.collection("audit_log").createIndex({ at: -1 }, { name: "audit_recent" }),
      db.collection("payments").createIndex({ requestId: 1 }, { name: "payments_request" }),
      db.collection("payments").createIndex({ orderId: 1 }, { name: "payments_order" }),   // the webhook only knows the order id
      db.collection("reimbursements").createIndex({ requestId: 1 }, { name: "reimbursements_request" }),
    ]).then(() => undefined);
    await this.indexed;
    return db;
  }

  async load(): Promise<Partial<Snapshot> | null> {
    const db = await this.db();
    const users = db.collection<Doc>("users");
    // First start on MongoDB: import what the JSON file already holds, so nobody has to register again.
    if (this.importFrom && (await users.estimatedDocumentCount()) === 0) {
      const old = await new JsonFilePersistence(this.importFrom).load();
      if (old && (old.helpers?.length || old.authorities?.length)) {
        await this.flush({ helpers: old.helpers ?? [], locations: old.locations ?? [], deletedLocations: [], zones: old.zones ?? [],
          authorities: old.authorities ?? [], audit: old.audit ?? [], payments: old.payments ?? [], reimbursements: old.reimbursements ?? [],
          full: { helpers: [], locations: [], zones: [], authorities: [], audit: [], payments: [], reimbursements: [] } });
        console.log(`[store] imported ${old.helpers?.length ?? 0} users from ${this.importFrom} into MongoDB`);
      }
    }
    const [helpers, locations, zones, authorities, audit, payments, reimbursements] = await Promise.all([
      users.find().toArray(), db.collection<Doc>("user_locations").find().toArray(), db.collection<Doc>("zones").find().toArray(),
      db.collection<Doc>("authorities").find().toArray(), db.collection<Doc>("audit_log").find().sort({ at: -1 }).limit(500).toArray(),
      db.collection<Doc>("payments").find().toArray(), db.collection<Doc>("reimbursements").find().toArray(),
    ]);
    return { helpers: helpers.map((d) => strip<Helper>(d)), locations: locations.map((d) => strip<UserLocation>(d)), zones: zones.map((d) => strip<Zone>(d)),
      authorities: authorities.map((d) => strip<Authority>(d)), audit: audit.map((d) => strip<AuditEntry>(d)),
      payments: payments.map((d) => strip<Payment>(d)), reimbursements: reimbursements.map((d) => strip<Reimbursement>(d)) };
  }

  async flush(c: Changes) {
    const db = await this.db();
    const up = <T,>(docs: T[], key: (d: T) => string, extra?: (d: T) => Record<string, unknown>) =>
      docs.map((d) => ({ replaceOne: { filter: { _id: key(d) }, replacement: { ...(d as object), ...(extra ? extra(d) : {}) } as Doc, upsert: true } }));
    const jobs: Promise<unknown>[] = [];
    if (c.helpers.length) jobs.push(db.collection<Doc>("users").bulkWrite(up(c.helpers, (h) => h.id, (h) => ({ geo: point(h.location), updatedAt: new Date().toISOString() }))));
    if (c.locations.length || c.deletedLocations.length) jobs.push(db.collection<Doc>("user_locations").bulkWrite([
      ...up(c.locations, (l) => l.phone, (l) => ({ geo: point(l.location) })),
      ...c.deletedLocations.map((phone) => ({ deleteOne: { filter: { _id: phone } } })),
    ]));
    if (c.zones.length) jobs.push(db.collection<Doc>("zones").bulkWrite(up(c.zones, (z) => z.id, (z) => ({ geo: point(z.center) }))));
    if (c.authorities.length) jobs.push(db.collection<Doc>("authorities").bulkWrite(up(c.authorities, (a) => a.username)));
    if (c.audit.length) jobs.push(db.collection<Doc>("audit_log").bulkWrite(up(c.audit, (e) => `${e.at}|${e.user}|${e.action}|${e.detail}`)));
    if (c.payments.length) jobs.push(db.collection<Doc>("payments").bulkWrite(up(c.payments, (p) => p.id)));
    if (c.reimbursements.length) jobs.push(db.collection<Doc>("reimbursements").bulkWrite(up(c.reimbursements, (r) => r.id)));
    await Promise.all(jobs);
  }
}
