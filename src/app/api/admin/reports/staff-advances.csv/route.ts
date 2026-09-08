import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  loadStaffAdvances,
  staffAdvancesCsvFilename,
  staffAdvancesCsvRows,
} from "@/lib/reports/staff-advances";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET() {
  const staff = await requireAdminStaff();
  const supabase = await createClient();
  const report = await loadStaffAdvances(supabase, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "staff_advances",
    filename: staffAdvancesCsvFilename(todayManilaISODate()),
    rows: staffAdvancesCsvRows(report.rows, report.staffById),
    truncated: report.truncated,
    filters: {},
  });
}
