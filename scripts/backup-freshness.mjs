// Read-only evidence that the nightly encrypted database backup arrived.
// No database access; only lists blob metadata, never uploads or deletes.
import { list } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token?.trim()) {
  throw new Error("BLOB_READ_WRITE_TOKEN secret is not set — refusing to skip backup monitoring.");
}

const maxAge = 48 * 60 * 60 * 1000;
let cursor;
let newest;
do {
  const page = await list({ prefix: "db-backups/", cursor, token, limit: 1000 });
  for (const blob of page.blobs) {
    const uploadedAt = new Date(blob.uploadedAt).getTime();
    if (!Number.isFinite(uploadedAt)) {
      throw new Error(`Invalid upload timestamp for backup ${blob.pathname}`);
    }
    if (!newest || uploadedAt > newest.uploadedAt) {
      newest = { pathname: blob.pathname, uploadedAt, size: blob.size };
    }
  }
  if (page.hasMore && (!page.cursor || page.cursor === cursor)) {
    throw new Error("Backup listing is incomplete — missing or repeated pagination cursor.");
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

if (!newest) {
  console.log("Newest backup: none | age: unknown | size: unknown");
  throw new Error("No backups found under db-backups/.");
}

const age = Date.now() - newest.uploadedAt;
console.log(`Newest backup: ${newest.pathname} | age: ${(age / 3_600_000).toFixed(2)} hours | size: ${newest.size} bytes`);
if (age > maxAge) {
  throw new Error("Backup watchdog failed: newest backup is older than 48 hours.");
}
console.log("Backup watchdog passed: newest backup is within 48 hours.");
