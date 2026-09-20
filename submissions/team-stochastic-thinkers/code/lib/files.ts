/**
 * Identity documents uploaded for verification. Stored in MongoDB GridFS (bucket "id_proofs") when MongoDB is
 * configured, otherwise under .data/uploads/. Only the owner and signed-in authorities can read them.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getDb, mongoConfigured } from "./mongo";

export const ID_PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const ID_PROOF_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
const dir = () => `${process.cwd()}/.data/uploads`;

export async function saveIdProof(bytes: Buffer, meta: { ownerId: string; fileName: string; mime: string }): Promise<string> {
  if (mongoConfigured()) {
    const { GridFSBucket } = await import("mongodb");
    const bucket = new GridFSBucket(await getDb(), { bucketName: "id_proofs" });
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const up = bucket.openUploadStreamWithId(id as never, meta.fileName, { metadata: { ownerId: meta.ownerId, mime: meta.mime, uploadedAt: new Date().toISOString() } });
      up.on("finish", () => resolve()).on("error", reject);
      up.end(bytes);
    });
    return `gridfs:${id}`;
  }
  const id = randomUUID();
  mkdirSync(dir(), { recursive: true });
  writeFileSync(`${dir()}/${id}`, bytes);
  return `file:${id}`;
}

export async function readIdProof(fileId: string): Promise<Buffer | null> {
  try {
    const [kind, id] = fileId.split(":");
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    if (kind === "gridfs") {
      const { GridFSBucket } = await import("mongodb");
      const bucket = new GridFSBucket(await getDb(), { bucketName: "id_proofs" });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        bucket.openDownloadStream(id as never).on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve()).on("error", reject);
      });
      return Buffer.concat(chunks);
    }
    if (kind === "file") return readFileSync(`${dir()}/${id}`);
    return null;
  } catch {
    return null;
  }
}

// ─── Job photos (taken by the customer for the AI's photo requests; visible to the accepted worker) ────────────
export const JOB_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
export const JOB_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;

export async function saveJobPhoto(bytes: Buffer, meta: { jobId: string; label: string; mime: string }): Promise<string> {
  const { GridFSBucket } = await import("mongodb");
  const bucket = new GridFSBucket(await getDb(), { bucketName: "job_photos" });
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const up = bucket.openUploadStreamWithId(id as never, meta.label.slice(0, 80) || "photo", { metadata: { jobId: meta.jobId, mime: meta.mime, uploadedAt: new Date().toISOString() } });
    up.on("finish", () => resolve()).on("error", reject);
    up.end(bytes);
  });
  return `job_photos:${id}`;
}

export async function readJobPhoto(fileId: string): Promise<Buffer | null> {
  try {
    const [bucketName, id] = fileId.split(":");
    if (bucketName !== "job_photos" || !id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const { GridFSBucket } = await import("mongodb");
    const bucket = new GridFSBucket(await getDb(), { bucketName });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bucket.openDownloadStream(id as never).on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve()).on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// ─── Purchase receipts (photographed by the worker mid-job; read by the AI, approved by the customer) ──────────
// Same shape and same bucket-prefixed ids as job photos, in their own GridFS bucket: a receipt is evidence behind a
// money claim, so it is kept apart from the customer's job photos and never served from the job-photo route.
export const RECEIPT_MAX_BYTES = 6 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;

export async function saveReceipt(bytes: Buffer, meta: { requestId: string; workerId: string; mime: string }): Promise<string> {
  const { GridFSBucket } = await import("mongodb");
  const bucket = new GridFSBucket(await getDb(), { bucketName: "receipts" });
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const up = bucket.openUploadStreamWithId(id as never, `receipt-${meta.requestId}`, { metadata: { requestId: meta.requestId, workerId: meta.workerId, mime: meta.mime, uploadedAt: new Date().toISOString() } });
    up.on("finish", () => resolve()).on("error", reject);
    up.end(bytes);
  });
  return `receipts:${id}`;
}

export async function readReceipt(fileId: string): Promise<Buffer | null> {
  try {
    const [bucketName, id] = fileId.split(":");
    if (bucketName !== "receipts" || !id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const { GridFSBucket } = await import("mongodb");
    const bucket = new GridFSBucket(await getDb(), { bucketName });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bucket.openDownloadStream(id as never).on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve()).on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}
