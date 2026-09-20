/**
 * MongoDB singleton. One MongoClient per server process, kept on globalThis so Next.js dev hot reloads reuse the
 * same connection pool instead of opening a new one on every edit. Configure with MONGODB_URI (+ MONGODB_DB).
 */
import type { Db, MongoClient } from "mongodb";

type Cache = { client?: Promise<MongoClient>; db?: Promise<Db> };
const g = globalThis as unknown as { __resq_mongo_cache?: Cache };
const cache = (g.__resq_mongo_cache ??= {});

export const mongoConfigured = (): boolean => !!process.env.MONGODB_URI?.trim();

export function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return Promise.reject(new Error("MONGODB_URI is not set"));
  cache.client ??= (async () => {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: "resq", maxPoolSize: 10 });
    await client.connect();
    return client;
  })().catch((e) => { cache.client = undefined; cache.db = undefined; throw e; }); // retry on the next call
  return cache.client;
}

export function getDb(): Promise<Db> {
  cache.db ??= getMongoClient().then((c) => c.db(process.env.MONGODB_DB?.trim() || "resq"))
    .catch((e) => { cache.db = undefined; throw e; });
  return cache.db;
}
