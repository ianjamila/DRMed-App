import { NextResponse, type NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { isVisitView } from "@/lib/visits/classification";
import { revenueTrendCsvRows } from "@/lib/visits/revenue-presets";
import { loadRevenueTrend } from "@/lib/visits/revenue-trend.server";

// The 12-month revenue-by-classification table for the bookkeeper. Admin-only,
// RLS-scoped client, audit row via reportCsvResponse — the same contract as
// every report CSV (see /api/admin/visits.csv). Always 12 rows, so the row
// ceiling can never bite.
export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const rawView = req.nextUrl.searchParams.get("view");
  const view = isVisitView(rawView) ? rawView : "active";
  const today = todayManilaISODate();

  const trend = await loadRevenueTrend(await createClient(), today, view);
  if (!trend.ok) {
    await reportError({ scope: "revenue-trend.csv", error: trend.error });
    return NextResponse.json({ ok: false, error: "Couldn't build the CSV." }, { status: 500 });
  }

  return reportCsvResponse({
    staff,
    report: "revenue_trend",
    filename: `billed-revenue-by-classification-12-months-${today}${view === "active" ? "" : `-${view}`}.csv`,
    rows: revenueTrendCsvRows(trend.points),
    truncated: false,
    filters: { view, through: today },
  });
}
