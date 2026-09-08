import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  labTatCsvFilename,
  labTatCsvRows,
  loadLabTat,
  parseLabTatParams,
} from "@/lib/reports/lab-tat";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const params = parseLabTatParams(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  const report = await loadLabTat(supabase, params, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "lab_tat",
    filename: labTatCsvFilename(params),
    rows: labTatCsvRows(report.samples),
    truncated: report.truncated,
    filters: { ...params },
  });
}
