// How many RESULTS each visit has already released — lab and imaging lines
// only (never a package header, never a doctor consult or procedure), live
// rows on live visits. The one read behind the Delete action's audit row
// and the Patient AR "Results released" badge; the visit page and the
// Reception Queue count the same thing from rows they already load
// (countReleasedLines in ./payment-edit.ts).
//
// Registered in query-surfaces.test.ts as a `lab` + `live` surface.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DOCTOR_KINDS_PG_LIST } from "./classification";
import { chunk, fetchAllRows, IN_CHUNK, REPORT_EXPORT_MAX_ROWS, unique } from "@/lib/reports/paging";

type AnyClient = SupabaseClient<Database>;

/** Visit id → released result count. Visits with none are absent. */
export async function loadReleasedResultCounts(
  client: AnyClient,
  visitIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const ids of chunk(unique(visitIds), IN_CHUNK)) {
    // Paged: 200 visits can release more than PostgREST's 1,000-row cap.
    const { rows } = await fetchAllRows<{ id: string; visit_id: string }>(
      (from, to) =>
        client
          .from("test_requests")
          .select("id, visit_id, services!inner ( kind ), visits!inner ( id )")
          .in("visit_id", ids)
          .eq("status", "released")
          .eq("is_package_header", false)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to)
          .returns<{ id: string; visit_id: string }[]>(),
      REPORT_EXPORT_MAX_ROWS,
    );
    for (const r of rows) counts.set(r.visit_id, (counts.get(r.visit_id) ?? 0) + 1);
  }
  return counts;
}
