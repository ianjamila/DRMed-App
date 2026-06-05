import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildDailyMatrix,
  buildDoctorRollup,
  enumerateDays,
  type ChannelRow,
  type TotalsRow,
  type DoctorRow,
} from "@/lib/operations/daily-report";
import { OperationsTabs } from "./_components/operations-tabs";
import { SummaryCards } from "./_components/summary-cards";
import { DailyMatrixTable } from "./_components/daily-matrix";
import { DoctorPanel } from "./_components/doctor-panel";

interface SearchParams {
  from?: string;
  to?: string;
}

function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export default async function OperationsDailyReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  const monthStart = today.slice(0, 7) + "-01";
  const from = params.from ?? monthStart;
  const monthEnd = lastDayOfMonth(monthStart);
  const to = params.to ?? (monthEnd < today ? monthEnd : today);

  const admin = createAdminClient();
  const [channelRes, totalsRes, doctorRes] = await Promise.all([
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
  ]);

  if (channelRes.error || totalsRes.error || doctorRes.error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <p className="mt-6 text-sm text-red-700">
          Could not load the operational report. Please try again.
        </p>
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

  const csvHref = `/api/admin/operations/daily.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <a
          href={csvHref}
          className="min-h-[44px] rounded border px-3 py-2 text-sm text-[color:var(--color-brand-navy)]"
        >
          Export CSV
        </a>
      </div>
      <OperationsTabs />

      <form className="mt-3 flex flex-wrap items-end gap-2 text-sm" method="get">
        <label className="flex flex-col">
          From
          <input type="date" name="from" defaultValue={from} className="rounded border px-2 py-1" />
        </label>
        <label className="flex flex-col">
          To
          <input type="date" name="to" defaultValue={to} className="rounded border px-2 py-1" />
        </label>
        <button type="submit" className="min-h-[44px] rounded border px-3 py-1">Apply</button>
      </form>

      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Totals are <strong>lab + consult only</strong> — rent, mobile APE, and procedures are
        excluded, so on days with those line items this reads slightly under the manual sheet.
      </p>

      <SummaryCards matrix={matrix} />
      <DailyMatrixTable matrix={matrix} />
      <DoctorPanel groups={doctorGroups} />
    </div>
  );
}
