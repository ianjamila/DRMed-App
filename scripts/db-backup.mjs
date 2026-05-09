// Uploads the local age-encrypted pg_dump to private Vercel Blob, then sweeps
// any blobs under the same prefix older than BLOB_RETENTION_DAYS.
//
// Required env:
//   BLOB_READ_WRITE_TOKEN   — Vercel Blob R/W token
//   BLOB_LOCAL_PATH         — path to file to upload
//   BLOB_PATHNAME           — destination key in the blob store
//   BLOB_PREFIX             — prefix to scan for retention sweep
//   BLOB_RETENTION_DAYS     — integer; blobs older than this are deleted
//
// Run from a GitHub Actions workflow. Not part of the runtime app.

import { readFile, stat } from "node:fs/promises";
import { put, list, del } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN;
const localPath = process.env.BLOB_LOCAL_PATH;
const pathname = process.env.BLOB_PATHNAME;
const prefix = process.env.BLOB_PREFIX ?? "db-backups/";
const retentionDays = Number(process.env.BLOB_RETENTION_DAYS ?? "30");

if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
if (!localPath) throw new Error("BLOB_LOCAL_PATH is not set");
if (!pathname) throw new Error("BLOB_PATHNAME is not set");
if (!Number.isFinite(retentionDays) || retentionDays < 1) {
  throw new Error("BLOB_RETENTION_DAYS must be a positive integer");
}

const fileInfo = await stat(localPath);
const body = await readFile(localPath);

// `access: 'private'` is in public beta. Defense-in-depth on top of age
// encryption — even if the upload URL leaks, the bytes are also unreadable
// without the offline private key.
const uploaded = await put(pathname, body, {
  access: "private",
  addRandomSuffix: false,
  contentType: "application/octet-stream",
  token,
});
console.log(
  `uploaded ${pathname} (${fileInfo.size} bytes) → ${uploaded.url}`,
);

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
let cursor;
let deleted = 0;
do {
  const page = await list({ prefix, cursor, token, limit: 1000 });
  cursor = page.cursor;
  const stale = page.blobs.filter((b) => {
    const uploadedAt = new Date(b.uploadedAt).getTime();
    return Number.isFinite(uploadedAt) && uploadedAt < cutoff;
  });
  if (stale.length > 0) {
    await del(
      stale.map((b) => b.url),
      { token },
    );
    deleted += stale.length;
  }
} while (cursor);
console.log(`retention sweep: deleted ${deleted} blobs older than ${retentionDays}d`);
