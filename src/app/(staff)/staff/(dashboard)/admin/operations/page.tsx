import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildDailyMatrix,
  buildDoctorRollup,
  enumerateDays,
  num,
  type ChannelRow,
  type TotalsRow,
  type DoctorRow,
} from "@/lib/operations/daily-report";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OperationsTabs } from "./_components/operations-tabs";
import { DateControls } from "./_components/date-controls";
import { SummaryCards } from "./_components/summary-cards";
import { DailyMatrixTable } from "./_components/daily-matrix";
import { DoctorPanel } from "./_components/doctor-panel";

interface SearchParams {
  from?: string;
  to?: string;
}

export default async function OperationsDailyReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  // Default to the current year so you land on the 12-month overview — the matrix
  // collapses columns by month; click a month to expand its days.
  const from = params.from ?? `${today.slice(0, 4)}-01-01`;
  const to = params.to ?? today;

  const admin = createAdminClient();
  const [channelRes, totalsRes, doctorRes, expensesRes] = await Promise.all([
    admin
      .from("v_ops_daily_channel")
      .select("business_date, section, channel, line_count, distinct_customers, sales_gross, discount, net")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_totals")
      .select("business_date, section, line_count, distinct_customers, sales_gross, discount, net, pf_collected")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_doctor")
      .select("business_date, physician_id, full_name, specialty, compensation_arrangement, consult_count, sales_gross, pf_collected")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_expenses")
      .select("business_date, expense_php")
      .gte("business_date", from)
      .lte("business_date", to),
  ]);

  if (channelRes.error || totalsRes.error || doctorRes.error || expensesRes.error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the operational report. Please try again.
        </Card>
      </div>
    );
  }

  const days = enumerateDays(from, to);
  const matrix = buildDailyMatrix(
    (channelRes.data ?? []) as ChannelRow[],
    (totalsRes.data ?? []) as TotalsRow[],
    days,
  );
  const doctorGroups = buildDoctorRollup((doctorRes.data ?? []) as DoctorRow[]);

  const expensesByDay: Record<string, number> = {};
  for (const r of expensesRes.data ?? []) {
    if (r.business_date) expensesByDay[r.business_date] = num(r.expense_php);
  }
  const expenseTotal = Object.values(expensesByDay).reduce((a, b) => a + b, 0);

  const csvHref = `/api/admin/operations/daily.csv?from=${from}&to=${to}`;

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
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} />

      <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        Revenue is <strong>lab + consult only</strong> (rent, mobile APE, procedures excluded).
        <strong> Net is rough</strong>: revenue after discounts minus <em>all</em> posted
        expenses from the books — so it mixes lab+consult revenue with clinic-wide expenses
        (full expense P&amp;L lands in a later phase).
      </p>

      <SummaryCards matrix={matrix} expenseTotal={expenseTotal} />
      <DailyMatrixTable matrix={matrix} expensesByDay={expensesByDay} />
      <DoctorPanel groups={doctorGroups} />
    </div>
  );
}
