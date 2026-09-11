import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  enumerateDays,
  buildDailyMatrix,
  type ChannelRow,
  type TotalsRow,
} from "@/lib/operations/daily-report";
import {
  buildCollectionsMatrix,
  type CollectionRow,
  type HmoReceivedRow,
} from "@/lib/operations/cash-report";
import {
  buildExpenseMatrix,
  buildNetIncome,
  buildCashFlow,
  type ExpenseAccountRow,
} from "@/lib/operations/expense-report";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";

// N15: see operations/daily.csv for why the service-role client stays for
// these `security_invoker` views. Admin gate, chunked paging and the audit
// row are the actual fix here.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const today = todayManilaISODate();
  const from = sp.get("from") ?? today.slice(0, 7) + "-01";
  const to = sp.get("to") ?? today;

  const admin = createAdminClient();
  const [expenseResult, totalsResult, collectionsResult, hmoResult] = await Promise.all([
    fetchAllRows<ExpenseAccountRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_expense_accounts")
          .select("*")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("code", { ascending: true })
          .range(rFrom, rTo)
          .returns<ExpenseAccountRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<TotalsRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_totals")
          .select("*")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("section", { ascending: true })
          .range(rFrom, rTo)
          .returns<TotalsRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<CollectionRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_collections")
          .select("*")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("section", { ascending: true })
          .order("method", { ascending: true })
          .range(rFrom, rTo)
          .returns<CollectionRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<HmoReceivedRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_hmo_received")
          .select("*")
          .gte("received_date", from)
          .lte("received_date", to)
          .order("received_date", { ascending: true })
          .order("source", { ascending: true })
          .range(rFrom, rTo)
          .returns<HmoReceivedRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
  ]);

  const days = enumerateDays(from, to);
  const matrix = buildExpenseMatrix(expenseResult.rows, days);
  const dailyMatrix = buildDailyMatrix([] as ChannelRow[], totalsResult.rows, days);
  const netIncome = buildNetIncome(dailyMatrix.totals.net.byDay, matrix.total.byDay, days);
  const collectionsMatrix = buildCollectionsMatrix(collectionsResult.rows, days, hmoResult.rows);
  const cashFlow = buildCashFlow(collectionsMatrix.total.values, matrix.total.byDay, days);

  const header = ["Section", "Row", ...days, "Total"];
  const body: unknown[][] = [];
  const push = (section: string, label: string, byDay: Record<string, number>) => {
    const rowTotal = days.reduce((s, d) => s + (byDay[d] ?? 0), 0);
    body.push([section, label, ...days.map((d) => byDay[d] ?? 0), rowTotal]);
  };

  for (const cat of matrix.categories) {
    for (const line of cat.lines) push(cat.name, line.label, line.byDay);
    push(cat.name, cat.subtotal.label, cat.subtotal.byDay);
  }
  if (matrix.other) push("Other", matrix.other.label, matrix.other.byDay);
  push("TOTAL", matrix.total.label, matrix.total.byDay);

  push("P&L", "Gross profit (lab + consult)", netIncome.grossProfit);
  push("P&L", "Net income (operational)", netIncome.net);

  push("Cash flow", cashFlow.starting.label, cashFlow.starting.byDay);
  push("Cash flow", cashFlow.collected.label, cashFlow.collected.byDay);
  push("Cash flow", cashFlow.expenses.label, cashFlow.expenses.byDay);
  push("Cash flow", cashFlow.ending.label, cashFlow.ending.byDay);

  return reportCsvResponse({
    staff,
    report: "ops_expenses",
    filename: `expenses-pnl-${from}_${to}.csv`,
    rows: [header, ...body],
    truncated:
      expenseResult.truncated ||
      totalsResult.truncated ||
      collectionsResult.truncated ||
      hmoResult.truncated,
    filters: { from, to },
  });
}
