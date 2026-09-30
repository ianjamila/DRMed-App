import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { isVisitView } from "@/lib/visits/classification";
import { loadRevenueTrend } from "@/lib/visits/revenue-trend.server";

// The "Revenue by classification" 12-month trend. Fetched by the dropdown only
// when an admin opens it (and straight away on Monthly Trends), so the
// collapsed-by-default strip costs no extra queries on every page view.
//
// Aggregates only — no patient rows, names or ids — so there is no RA 10173
// disclosure to audit here, but it is still revenue, hence requireAdminStaff.
// The RLS-scoped client + the SECURITY INVOKER RPC mean it can never count a
// row the caller could not already read. The CSV twin (…/reports/
// revenue-trend.csv) does write an export audit row, like every report CSV.

export async function GET(req: NextRequest) {
  await requireAdminStaff();
  const rawView = req.nextUrl.searchParams.get("view");
  const view = isVisitView(rawView) ? rawView : "active";

  const trend = await loadRevenueTrend(await createClient(), todayManilaISODate(), view);
  if (!trend.ok) {
    await reportError({ scope: "revenue-trend", error: trend.error });
    return NextResponse.json({ ok: false, error: "Couldn't load the trend." }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, points: trend.points },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
