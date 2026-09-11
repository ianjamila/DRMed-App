import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  buildDailyMatrix,
  enumerateDays,
  num,
  type ChannelRow,
  type TotalsRow,
} from "@/lib/operations/daily-report";

// N15: admin gate + chunked paging + an audit row, brought up to the standard
// the seven `src/lib/reports/*` exports meet (`reportCsvResponse` supplies the
// audit row, the in-band TRUNCATED marker, and the response headers).
//
// The service-role client stays, deliberately, for the three `v_ops_daily_*`
// reads: those views are `security_invoker = on` with no RLS path that lets a
// staff JWT (even an admin one) see clinic-wide financials aggregated across
// every patient — see the "read in practice only by the service-role admin
// client" note atop migrations 0093/0094. Switching these to the RLS-scoped
// client would silently return zero rows, not merely narrower ones.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const today = todayManilaISODate();
  const from = sp.get("from") ?? today.slice(0, 7) + "-01";
  const to = sp.get("to") ?? today;

  const admin = createAdminClient();
  const [channelResult, totalsResult, expensesResult] = await Promise.all([
    fetchAllRows<ChannelRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_channel")
          .select("business_date, section, channel, line_count, distinct_customers, sales_gross, discount, net")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("section", { ascending: true })
          .order("channel", { ascending: true })
          .range(rFrom, rTo)
          .returns<ChannelRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<TotalsRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_totals")
          .select("business_date, section, line_count, distinct_customers, sales_gross, discount, net, pf_collected")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("section", { ascending: true })
          .range(rFrom, rTo)
          .returns<TotalsRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<{ business_date: string | null; expense_php: number | null }>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_expenses")
          .select("business_date, expense_php")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .range(rFrom, rTo),
      REPORT_EXPORT_MAX_ROWS,
    ),
  ]);

  const days = enumerateDays(from, to);
  const matrix = buildDailyMatrix(channelResult.rows, totalsResult.rows, days);

  const expensesByDay: Record<string, number> = {};
  for (const r of expensesResult.rows) {
    if (r.business_date) expensesByDay[r.business_date] = num(r.expense_php);
  }
  const expenseTotal = days.reduce((a, d) => a + (expensesByDay[d] ?? 0), 0);

  const header = ["Section", "Metric", ...days, "Total"];
  const body: unknown[][] = [];
  for (const sec of matrix.sections) {
    for (const row of sec.rows) {
      body.push([sec.title, row.label, ...days.map((d) => row.byDay[d] ?? 0), row.total]);
    }
  }
  for (const row of [matrix.totals.revenue, matrix.totals.discount, matrix.totals.net]) {
    body.push(["TOTAL", row.label, ...days.map((d) => row.byDay[d] ?? 0), row.total]);
  }
  body.push([
    "TOTAL",
    "Expenses (all, from books)",
    ...days.map((d) => expensesByDay[d] ?? 0),
    expenseTotal,
  ]);
  body.push([
    "TOTAL",
    "Net (rough = profit - expenses)",
    ...days.map((d) => (matrix.totals.net.byDay[d] ?? 0) - (expensesByDay[d] ?? 0)),
    matrix.totals.net.total - expenseTotal,
  ]);

  return reportCsvResponse({
    staff,
    report: "ops_daily",
    filename: `operations-daily-${from}-to-${to}.csv`,
    rows: [header, ...body],
    truncated: channelResult.truncated || totalsResult.truncated || expensesResult.truncated,
    filters: { from, to },
  });
}
