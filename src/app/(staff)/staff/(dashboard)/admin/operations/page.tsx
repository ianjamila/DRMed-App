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
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
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
  // N14: paged the same way as daily.csv (same PAGE_SIZE/REPORT_EXPORT_MAX_ROWS
  // ceiling, `fetchAllRows`) so the figures on screen can never fall behind
  // what the export shows — a plain select silently caps at 1000 rows, and
  // this view crosses that within a year of channel/section rows. Each
  // query needs its own total order (`.order(...)` down to a column that
  // makes the row set stable) or `.range()` paging can repeat or drop rows.
  let channelResult: { rows: ChannelRow[]; truncated: boolean };
  let totalsResult: { rows: TotalsRow[]; truncated: boolean };
  let doctorResult: { rows: DoctorRow[]; truncated: boolean };
  let expensesResult: {
    rows: { business_date: string | null; expense_php: number | null }[];
    truncated: boolean;
  };
  try {
    [channelResult, totalsResult, doctorResult, expensesResult] = await Promise.all([
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
      fetchAllRows<DoctorRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_doctor")
            .select("business_date, physician_id, full_name, specialty, compensation_arrangement, clinic_cut_php, consult_count, sales_gross, pf_collected")
            .gte("business_date", from)
            .lte("business_date", to)
            .order("business_date", { ascending: true })
            .order("physician_id", { ascending: true, nullsFirst: true })
            .range(rFrom, rTo)
            .returns<DoctorRow[]>(),
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
  } catch {
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

  const truncated =
    channelResult.truncated ||
    totalsResult.truncated ||
    doctorResult.truncated ||
    expensesResult.truncated;

  const days = enumerateDays(from, to);
  const matrix = buildDailyMatrix(channelResult.rows, totalsResult.rows, days);
  const doctorGroups = buildDoctorRollup(doctorResult.rows);

  const expensesByDay: Record<string, number> = {};
  for (const r of expensesResult.rows) {
    if (r.business_date) expensesByDay[r.business_date] = num(r.expense_php);
  }
  const expenseTotal = Object.values(expensesByDay).reduce((a, b) => a + b, 0);

  const csvHref = `/api/admin/operations/daily.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <ExportCsvLink href={csvHref} />
      </div>
      <OperationsTabs />

      {/* key on the range so the custom From/To inputs re-init after a pill/year
          navigation (useState would otherwise keep its stale initial value). */}
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} />

      {truncated ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of at least one
          section — narrow the date range to see the rest.
        </p>
      ) : null}

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
