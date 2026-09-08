import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  dailyRevenueCsvFilename,
  dailyRevenueCsvRows,
  loadDailyRevenue,
  parseDailyRevenueParams,
} from "@/lib/reports/daily-revenue";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const params = parseDailyRevenueParams(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  const report = await loadDailyRevenue(supabase, params, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "daily_revenue",
    filename: dailyRevenueCsvFilename(params),
    rows: dailyRevenueCsvRows(report.rows),
    truncated: report.truncated,
    filters: { ...params },
  });
}
