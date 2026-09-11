// Finding 15: pure, chunked patient-lookup core for the emails-log page and
// its CSV export. NO "server-only" import so this is vitest-testable —
// query.ts (which does carry "server-only") wraps it with a real Supabase
// call.
//
// The original `resolvePatients` ran one unpaged `.in("id", ids)` over
// every distinct patient_id in the (already-paged) audit rows. The export
// can walk up to EXPORT_CAP (10,000) audit rows, which can easily name more
// than 1000 distinct patients — past that a plain PostgREST select silently
// caps (see CLAUDE.md's PostgREST limits note), and the `.in()` list itself
// can also blow the request size limit well before that. The original also
// discarded the query's error (`const { data } = await …`), so a failed
// lookup came back as an empty map indistinguishable from "no patients on
// this page" — the export then shipped rows with missing names/DRM-IDs
// while its own audit row and on-screen state still called itself complete.
import { chunk, IN_CHUNK } from "@/lib/reports/paging";

export interface PatientLookupChunkResult<P> {
  data: P[] | null;
  error: { message: string } | null;
}

/** One `.in("id", chunkIds)` call. Injected so this stays DB-free and pure. */
export type PatientLookupFetcher<P> = (
  chunkIds: readonly string[],
) => PromiseLike<PatientLookupChunkResult<P>>;

/**
 * Resolve `ids` to rows keyed by id, walking the set in `IN_CHUNK`-sized
 * batches rather than one unbounded `.in()` call. Throws on the first
 * chunk's error instead of swallowing it — a partial enrichment that reads
 * as complete is worse than a failed request (same contract as
 * `fetchAllRows` in `src/lib/reports/paging.ts`).
 */
export async function resolvePatientsByIdChunked<P extends { id: string }>(
  ids: readonly string[],
  fetchChunk: PatientLookupFetcher<P>,
): Promise<Map<string, P>> {
  const map = new Map<string, P>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return map;

  for (const idChunk of chunk(uniqueIds, IN_CHUNK)) {
    const { data, error } = await fetchChunk(idChunk);
    if (error) {
      throw new Error(`Patient lookup chunk failed: ${error.message}`);
    }
    for (const p of data ?? []) map.set(p.id, p);
  }
  return map;
}
