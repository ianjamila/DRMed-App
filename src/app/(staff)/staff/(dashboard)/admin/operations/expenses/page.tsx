import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  enumerateDays,
  buildDailyMatrix,
  type TotalsRow,
  type ChannelRow,
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
  booksNetIncome,
  type ExpenseAccountRow,
  type PnlRow,
} from "@/lib/operations/expense-report";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { Card } from "@/components/ui/card";
import { OperationsTabs } from "../_components/operations-tabs";
import { DateControls } from "../_components/date-controls";
import { ExpenseSummaryCards } from "./_components/expense-summary-cards";
import { ExpenseMatrixTable } from "./_components/expense-matrix";
import { PnlSummary } from "./_components/pnl-summary";
import { CashFlowPanel } from "./_components/cash-flow-panel";

const BASE = "/staff/admin/operations/expenses";

interface SearchParams {
  from?: string;
  to?: string;
}

export default async function ExpensesPnlPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  const from = params.from ?? `${today.slice(0, 4)}-01-01`;
  const to = params.to ?? today;

  const admin = createAdminClient();
  // N14: paged the same way as expenses.csv (same ceiling, same
  // `fetchAllRows`) so this screen's figures can't fall behind the export's.
  // `v_ops_daily_pnl` has no export counterpart to copy the shape from, so it
  // gets the same treatment here directly.
  let expenseResult: { rows: ExpenseAccountRow[]; truncated: boolean };
  let totalsResult: { rows: TotalsRow[]; truncated: boolean };
  let collectionsResult: { rows: CollectionRow[]; truncated: boolean };
  let hmoResult: { rows: HmoReceivedRow[]; truncated: boolean };
  let pnlResult: { rows: PnlRow[]; truncated: boolean };
  try {
    [expenseResult, totalsResult, collectionsResult, hmoResult, pnlResult] = await Promise.all([
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
      fetchAllRows<PnlRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_pnl")
            .select("*")
            .gte("business_date", from)
            .lte("business_date", to)
            .order("business_date", { ascending: true })
            .range(rFrom, rTo)
            .returns<PnlRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
    ]);
  } catch {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the expenses &amp; P&amp;L report. Please try again.
        </Card>
      </div>
    );
  }

  const truncated =
    expenseResult.truncated ||
    totalsResult.truncated ||
    collectionsResult.truncated ||
    hmoResult.truncated ||
    pnlResult.truncated;

  const days = enumerateDays(from, to);

  const expenseMatrix = buildExpenseMatrix(expenseResult.rows, days);

  // Gross profit (lab + consult net) from B1.1's totals view.
  // Pass [] for channels — only totals.net is needed here, not per-channel section rows.
  const dailyMatrix = buildDailyMatrix([] as ChannelRow[], totalsResult.rows, days);
  const grossProfitByDay = dailyMatrix.totals.net.byDay;
  const netIncome = buildNetIncome(grossProfitByDay, expenseMatrix.total.byDay, days);

  // Cash collected from B1.2 — .total.values is the per-day grand total keyed by ISO day.
  const collectionsMatrix = buildCollectionsMatrix(collectionsResult.rows, days, hmoResult.rows);
  const cashFlow = buildCashFlow(collectionsMatrix.total.values, expenseMatrix.total.byDay, days);

  const booksNet = booksNetIncome(pnlResult.rows);

  const csvHref = `/api/admin/operations/expenses.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <ExportCsvLink href={csvHref} />
      </div>
      <OperationsTabs />

      {/* key on the range so the custom From/To inputs re-init after a pill/year
          navigation (useState would otherwise keep its stale initial value). */}
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} basePath={BASE} />

      {truncated ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of at least one
          section — narrow the date range to see the rest.
        </p>
      ) : null}

      <ExpenseSummaryCards matrix={expenseMatrix} netIncome={netIncome} cashFlow={cashFlow} />
      <ExpenseMatrixTable matrix={expenseMatrix} />
      <PnlSummary netIncome={netIncome} booksNet={booksNet} />
      <CashFlowPanel cashFlow={cashFlow} />
    </div>
  );
}
