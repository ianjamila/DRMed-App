import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCompleteRows, IN_CHUNK } from "@/lib/reports/paging";
import { foldPrintEvents, type PrintEventRow, type PrintSummary } from "./print-summary";

/**
 * Who printed each of these result FILES, and when last — for the
 * "Printed …" note under the Print result buttons, so the counter doesn't
 * hand the same result over twice.
 *
 * audit_log is admin-only under RLS, and reception is the role this is for,
 * so this reads through the service-role client (as countResultViews does)
 * and hands back only the derived fact: a count, a time and a staff name —
 * never the rows. Only `result.printed_staff` rows count (written by the PDF
 * route and the visit's Print all), not on-screen views. Keyed by file, and
 * only prints of each file's CURRENT version (amendment_count) count — see
 * print-summary.ts; look a line up through its PdfState.resultId.
 *
 * Every chunk is read to the end (fetchCompleteRows, ordered by id): a bare
 * select stops at 1000 rows, which would understate counts and could drop
 * the latest print. Pass `patientId` when every file belongs to one patient
 * (the visit page): it narrows the read to that patient's rows (indexed).
 */
export async function fetchPrintSummaries(
  files: readonly { resultId: string; version: number }[],
  opts: { patientId?: string } = {},
): Promise<Map<string, PrintSummary>> {
  const versions = new Map(files.map((f) => [f.resultId, f.version]));
  const ids = [...versions.keys()];
  if (ids.length === 0) return new Map();
  const admin = createAdminClient();

  const rows: PrintEventRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await fetchCompleteRows((from, to) => {
      let q = admin
        .from("audit_log")
        .select(
          "id, result_id:metadata->>result_id, amendment_count:metadata->>amendment_count, created_at, actor_id",
        )
        .eq("action", "result.printed_staff")
        .in("metadata->>result_id", slice);
      if (opts.patientId) q = q.eq("patient_id", opts.patientId);
      return q.order("id", { ascending: true }).range(from, to);
    });
    // A note is a convenience: on a read error show none rather than a
    // wrong one, and never fail the page over it.
    if (error || !data) return new Map();
    rows.push(...data);
  }

  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_id).filter((id): id is string => id !== null)),
  );
  const names = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", actorIds);
    for (const p of data ?? []) names.set(p.id, p.full_name);
  }
  return foldPrintEvents(rows, names, versions);
}
