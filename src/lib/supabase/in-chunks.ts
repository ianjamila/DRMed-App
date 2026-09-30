import { chunkIds } from "@/lib/patients/require-active-core";

// A bulk action can carry up to MAX_BULK_RECORDS (500) ids, and PostgREST puts
// every `.in("id", […])` value in the request URL — 500 uuids is ~19 KB, past
// what proxies accept. The repo precedent (patients/require-active.ts,
// appointments/actions.ts ID_CHUNK) is 200 per call; this is that rule as ONE
// shared helper for the bulk queue's READS. Never use it for a write: the
// bulk writes are single statements / per-row updates by design.
export const IN_CHUNK = 200;

/**
 * Run `fetch` once per IN_CHUNK-sized slice of the (deduplicated) ids and
 * concatenate the rows in slice order. Fails CLOSED: the first errored slice
 * ends the read with `ok: false` and that slice's error, and no partial rows
 * are returned — a missing slice must never read as "those rows do not
 * exist". An empty id list makes no call.
 *
 * Row order is per slice, then the query's own order within it, so a caller
 * that needs a total order must not lean on the database's default one (none of
 * the bulk reads do: they build Maps / test `.every`).
 */
export async function readInChunks<Row, E = unknown>(
  ids: readonly string[],
  fetch: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: E | null }>,
  size: number = IN_CHUNK,
): Promise<{ ok: true; rows: Row[] } | { ok: false; error: E }> {
  const rows: Row[] = [];
  for (const chunk of chunkIds([...new Set(ids)], size)) {
    const { data, error } = await fetch(chunk);
    if (error) return { ok: false, error };
    rows.push(...(data ?? []));
  }
  return { ok: true, rows };
}
