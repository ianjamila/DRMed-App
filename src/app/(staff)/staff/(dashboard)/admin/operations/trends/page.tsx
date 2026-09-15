import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Card } from "@/components/ui/card";
import { buildMonthlyPnl } from "@/lib/operations/trends";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { OperationsTabs } from "../_components/operations-tabs";
import { PnlTrendChart } from "./_components/pnl-trend-chart";

interface TotalsRow {
  business_date: string | null;
  net: number | null;
}
interface ExpenseRow {
  business_date: string | null;
  expense_php: number | null;
}

export const metadata = { title: "Trends" };

export default async function OperationsTrendsPage() {
  await requireAdminStaff();

  const admin = createAdminClient();
  // This chart is all-time and both views long ago outgrew PostgREST's silent
  // 1000-row cap: `v_ops_daily_totals` is at (business_date, section) grain —
  // TWO rows a trading day — so a plain select was returning an arbitrary 1000
  // of 1421 rows and the chart was quietly understating gross profit by ₱4.5M
  // across 9 missing months. Paged exactly like the Daily report page, which
  // reads the same views. Each query needs its own TOTAL order or `.range()`
  // paging can repeat or drop rows between pages.
  let totalsResult: { rows: TotalsRow[]; truncated: boolean };
  let expensesResult: { rows: ExpenseRow[]; truncated: boolean };
  try {
    [totalsResult, expensesResult] = await Promise.all([
      fetchAllRows<TotalsRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_totals")
            .select("business_date, net")
            .order("business_date", { ascending: true })
            .order("section", { ascending: true })
            .range(rFrom, rTo)
            .returns<TotalsRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
      fetchAllRows<ExpenseRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_expenses")
            .select("business_date, expense_php")
            .order("business_date", { ascending: true })
            .range(rFrom, rTo)
            .returns<ExpenseRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
    ]);
  } catch {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the trends data. Please try again.
        </Card>
      </div>
    );
  }

  const truncated = totalsResult.truncated || expensesResult.truncated;
  const data = buildMonthlyPnl(totalsResult.rows, expensesResult.rows);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
      <OperationsTabs />

      {truncated ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of at least one
          source — the earliest months may be incomplete.
        </p>
      ) : null}

      <PnlTrendChart data={data} />
    </div>
  );
}
