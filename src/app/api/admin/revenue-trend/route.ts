import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { isVisitView, summariseClasses } from "@/lib/visits/classification";
import { trendMonths, type RevenueTrendPoint } from "@/lib/visits/revenue-presets";

// The "Revenue by classification" dropdown's 12-month trend. Fetched by the
// dropdown only when an admin opens it, so the (collapsed-by-default) strip
// costs no extra queries on every page view.
//
// Aggregates only — no patient rows, names or ids — so there is no RA 10173
// disclosure to audit, but it is still revenue, hence requireAdminStaff. The
// RLS-scoped client + the SECURITY INVOKER RPC mean it can never count a row
// the caller could not already read.

export async function GET(req: NextRequest) {
  await requireAdminStaff();
  const rawView = req.nextUrl.searchParams.get("view");
  const view = isVisitView(rawView) ? rawView : "active";

  const supabase = await createClient();
  const months = trendMonths(todayManilaISODate());
  const results = await Promise.all(
    months.map((m) =>
      supabase.rpc("visits_classification_summary", {
        p_start: m.start,
        p_end: m.end,
        p_deleted: view,
      }),
    ),
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    await reportError({ scope: "revenue-trend", error: failed.error });
    return NextResponse.json({ ok: false, error: "Couldn't load the trend." }, { status: 500 });
  }

  const points: RevenueTrendPoint[] = months.map((m, i) => {
    const byClass = new Map(summariseClasses(results[i].data).map((r) => [r.class, r.revenuePhp]));
    return {
      key: m.key,
      label: m.label,
      year: m.year,
      partial: m.partial,
      lab: byClass.get("lab") ?? 0,
      consult: byClass.get("consult") ?? 0,
      procedure: byClass.get("procedure") ?? 0,
    };
  });

  return NextResponse.json(
    { ok: true, points },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
