import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  loadStuckTests,
  parseStuckTestsParams,
  stuckTestsCsvFilename,
  stuckTestsCsvRows,
} from "@/lib/reports/stuck-tests";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const params = parseStuckTestsParams(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  // One instant for the cutoff AND the Age column so a slow walk can't drift.
  const now = Date.now();
  const report = await loadStuckTests(supabase, params, REPORT_EXPORT_MAX_ROWS, now);
  return reportCsvResponse({
    staff,
    report: "stuck_tests",
    filename: stuckTestsCsvFilename(params, todayManilaISODate()),
    rows: stuckTestsCsvRows(report, report.claimerNames, now),
    truncated: report.truncated,
    filters: { ...params },
  });
}
