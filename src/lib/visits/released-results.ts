// How much COMPLETED WORK each visit carries — released lab and imaging
// results plus doctor consults / procedures marked done (never a package
// header), live rows on live visits, split the way countReleasedLines splits
// them. The one read behind the Delete / Edit / Move audit rows and alert,
// and the Patient AR "Completed work" filter and badge; the visit page and
// the Reception Queue count the same thing from rows they already load
// (completedWorkCount in ./payment-edit.ts).
//
// Registered in query-surfaces.test.ts as an `all` + `live` surface: this
// means every bill line, so the doctor kinds are NOT filtered out here — the
// results-vs-doctor split happens in countReleasedLines, in memory.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, IN_CHUNK, REPORT_EXPORT_MAX_ROWS, unique } from "@/lib/reports/paging";
import { countReleasedLines, type ReleasedCounts } from "./payment-edit";

type AnyClient = SupabaseClient<Database>;

export interface CompletedWorkRow {
  id: string;
  visit_id: string;
  status: string;
  is_package_header: boolean;
  services: { kind: string | null } | { kind: string | null }[] | null;
}

/** Visit id → released results / done consults / done procedures. Visits with none are absent. */
export async function loadCompletedWorkCounts(
  client: AnyClient,
  visitIds: readonly string[],
): Promise<Map<string, ReleasedCounts>> {
  const all: CompletedWorkRow[] = [];
  for (const ids of chunk(unique(visitIds), IN_CHUNK)) {
    // Paged: 200 visits can release more than PostgREST's 1,000-row cap.
    const { rows } = await fetchAllRows<CompletedWorkRow>(
      (from, to) =>
        client
          .from("test_requests")
          .select("id, visit_id, status, is_package_header, services!inner ( kind ), visits!inner ( id )")
          .in("visit_id", ids)
          .eq("status", "released")
          .eq("is_package_header", false)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to)
          .returns<CompletedWorkRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    );
    all.push(...rows);
  }
  return foldCompletedWork(all);
}

/** The pure fold behind loadCompletedWorkCounts — one ReleasedCounts per visit. */
export function foldCompletedWork(rows: readonly CompletedWorkRow[]): Map<string, ReleasedCounts> {
  const byVisit = new Map<string, CompletedWorkRow[]>();
  for (const r of rows) {
    const list = byVisit.get(r.visit_id);
    if (list) list.push(r);
    else byVisit.set(r.visit_id, [r]);
  }
  const counts = new Map<string, ReleasedCounts>();
  for (const [visitId, lines] of byVisit) {
    counts.set(
      visitId,
      countReleasedLines(
        lines.map((l) => {
          const svc = Array.isArray(l.services) ? l.services[0] : l.services;
          return { status: l.status, is_package_header: l.is_package_header, kind: svc?.kind };
        }),
      ),
    );
  }
  return counts;
}

/**
 * Visit id → released RESULT count only (lab and imaging; no doctor lines).
 * The results-only projection of loadCompletedWorkCounts, kept for callers
 * that mean results and nothing else. Visits with none are absent.
 */
export async function loadReleasedResultCounts(
  client: AnyClient,
  visitIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const [visitId, c] of await loadCompletedWorkCounts(client, visitIds)) {
    if (c.results > 0) counts.set(visitId, c.results);
  }
  return counts;
}
