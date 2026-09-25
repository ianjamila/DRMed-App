import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS, chunk } from "@/lib/reports/paging";
import { todayManilaISODate } from "@/lib/dates/manila";
import { parseSort } from "@/lib/ui/table-params";
import { parseKeptCounts, type KeptCounts } from "@/lib/patients/deletion";
import {
  DELETED_SORTABLE,
  deletedPatientsCsvFilename,
  deletedPatientsCsvRows,
  loadAllDeletedPatients,
} from "@/lib/reports/deleted-patients";

// Admin-only, RLS-scoped rows (v_patients_directory_admin, 0167), hard
// ceiling, audit row (report.deleted_patients.exported) — never the
// service-role client for the rows themselves. Kept counts are display
// enrichment only, read via patient_kept_counts (service_role) after the
// admin gate below — same pattern as the page.
export const maxDuration = 60;

const DEFAULT_SORT = { key: "deleted_at", dir: "desc" } as const;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const sort = parseSort(sp.get("sort") ?? undefined, sp.get("dir") ?? undefined, DELETED_SORTABLE, DEFAULT_SORT);
  const supabase = await createClient();
  const { rows, truncated } = await loadAllDeletedPatients(supabase, sort, REPORT_EXPORT_MAX_ROWS);

  const admin = createAdminClient();
  const kept = new Map<string, KeptCounts>();
  for (const ids of chunk(rows.map((r) => r.id), 500)) {
    const { data } = await admin.rpc("patient_kept_counts", { p_patient_ids: ids });
    for (const c of data ?? []) kept.set(c.patient_id, parseKeptCounts(c));
  }

  return reportCsvResponse({
    staff,
    report: "deleted_patients",
    filename: deletedPatientsCsvFilename(todayManilaISODate()),
    rows: deletedPatientsCsvRows(rows, kept),
    truncated,
    filters: { sort: sort.key, dir: sort.dir },
  });
}
