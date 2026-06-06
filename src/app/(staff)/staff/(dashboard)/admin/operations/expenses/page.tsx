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
import { buttonVariants } from "@/components/ui/button";
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
  const [expenseRes, totalsRes, collectionsRes, hmoRes, pnlRes] = await Promise.all([
    admin
      .from("v_ops_daily_expense_accounts")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_totals")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_collections")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_hmo_received")
      .select("*")
      .gte("received_date", from)
      .lte("received_date", to),
    admin
      .from("v_ops_daily_pnl")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
  ]);

  if (expenseRes.error || totalsRes.error || collectionsRes.error || hmoRes.error || pnlRes.error) {
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

  const days = enumerateDays(from, to);

  const expenseMatrix = buildExpenseMatrix(
    (expenseRes.data ?? []) as ExpenseAccountRow[],
    days,
  );

  // Gross profit (lab + consult net) from B1.1's totals view.
  // Pass [] for channels — only totals.net is needed here, not per-channel section rows.
  const dailyMatrix = buildDailyMatrix(
    [] as ChannelRow[],
    (totalsRes.data ?? []) as TotalsRow[],
    days,
  );
  const grossProfitByDay = dailyMatrix.totals.net.byDay;
  const netIncome = buildNetIncome(grossProfitByDay, expenseMatrix.total.byDay, days);

  // Cash collected from B1.2 — .total.values is the per-day grand total keyed by ISO day.
  const collectionsMatrix = buildCollectionsMatrix(
    (collectionsRes.data ?? []) as CollectionRow[],
    days,
    (hmoRes.data ?? []) as HmoReceivedRow[],
  );
  const cashFlow = buildCashFlow(collectionsMatrix.total.values, expenseMatrix.total.byDay, days);

  const booksNet = booksNetIncome((pnlRes.data ?? []) as PnlRow[]);

  const csvHref = `/api/admin/operations/expenses.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <a href={csvHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Export CSV
        </a>
      </div>
      <OperationsTabs />

      {/* key on the range so the custom From/To inputs re-init after a pill/year
          navigation (useState would otherwise keep its stale initial value). */}
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} basePath={BASE} />

      <ExpenseSummaryCards matrix={expenseMatrix} netIncome={netIncome} cashFlow={cashFlow} />
      <ExpenseMatrixTable matrix={expenseMatrix} />
      <PnlSummary netIncome={netIncome} booksNet={booksNet} />
      <CashFlowPanel cashFlow={cashFlow} />
    </div>
  );
}
