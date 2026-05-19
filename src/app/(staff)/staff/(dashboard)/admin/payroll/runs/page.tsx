import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { RunsClient, type RunListRow } from "./runs-client";

export const metadata = { title: "Pay runs — payroll admin" };
export const dynamic = "force-dynamic";

type RunStatus = "draft" | "computed" | "finalised" | "voided";
const ALL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "draft",
  "computed",
  "finalised",
  "voided",
]);

interface PageProps {
  // searchParams is async in Next.js 16.
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function PayrollRunsPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const currentYear = Number.parseInt(todayManilaISODate().slice(0, 4), 10);

  const yearParam = sp.year ? Number.parseInt(sp.year, 10) : currentYear;
  const year =
    Number.isFinite(yearParam) && yearParam >= 1900 && yearParam <= 2999
      ? yearParam
      : currentYear;

  const statusParam = sp.status ?? "all";
  const status: "all" | RunStatus =
    statusParam !== "all" && ALL_STATUSES.has(statusParam as RunStatus)
      ? (statusParam as RunStatus)
      : "all";

  // Service-role client to bypass RLS on the joined reads. The page is gated
  // by requireAdminStaff() so this is safe and avoids extra policy work for
  // the join across payroll_runs → payroll_periods → payroll_employee_runs.
  const admin = createAdminClient();

  // Year bounds in Asia/Manila wall-clock. payroll_periods.period_start is a
  // DATE column (no time) so plain YYYY-MM-DD bounds compare correctly.
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  // Step 1: fetch the runs joined to their period in the selected year. The
  // PostgREST inner-join filter (`period:payroll_periods!inner(...)`) restricts
  // by `period_start` on the joined row.
  let runsQuery = admin
    .from("payroll_runs")
    .select(
      "id, status, created_at, period:payroll_periods!inner(id, period_start, period_end, pay_date)",
    )
    .gte("period.period_start", yearStart)
    .lt("period.period_start", yearEnd);

  if (status !== "all") {
    runsQuery = runsQuery.eq("status", status);
  }

  const { data: rawRuns, error: runsErr } = await runsQuery;
  if (runsErr) {
    // Surface the error to the client by passing an empty list — the
    // page-level error boundary will handle anything more catastrophic.
    console.error("[payroll/runs] runs query failed:", runsErr);
  }

  // Step 2: aggregate payroll_employee_runs for the selected run ids.
  const runIds = (rawRuns ?? []).map((r) => r.id);
  type EmpAgg = {
    sumGross: number;
    sumNet: number;
    countTotal: number;
    countPaid: number;
  };
  const aggByRun = new Map<string, EmpAgg>();
  if (runIds.length > 0) {
    const { data: empRows, error: empErr } = await admin
      .from("payroll_employee_runs")
      .select("run_id, gross_pay_php, net_pay_php, payout_status")
      .in("run_id", runIds);
    if (empErr) {
      console.error("[payroll/runs] employee_runs query failed:", empErr);
    }
    for (const row of empRows ?? []) {
      const agg = aggByRun.get(row.run_id) ?? {
        sumGross: 0,
        sumNet: 0,
        countTotal: 0,
        countPaid: 0,
      };
      agg.sumGross += Number(row.gross_pay_php ?? 0);
      agg.sumNet += Number(row.net_pay_php ?? 0);
      agg.countTotal += 1;
      if (row.payout_status === "paid") agg.countPaid += 1;
      aggByRun.set(row.run_id, agg);
    }
  }

  // Shape rows for the client; PostgREST may return the to-one join as an
  // object or as a single-element array depending on the generated type.
  const runs: RunListRow[] = (rawRuns ?? [])
    .map((row) => {
      const period = Array.isArray(row.period) ? row.period[0] : row.period;
      const agg = aggByRun.get(row.id) ?? {
        sumGross: 0,
        sumNet: 0,
        countTotal: 0,
        countPaid: 0,
      };
      return {
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        period_start: period?.period_start ?? "",
        period_end: period?.period_end ?? "",
        pay_date: period?.pay_date ?? "",
        sum_gross_php: agg.sumGross,
        sum_net_php: agg.sumNet,
        count_total: agg.countTotal,
        count_paid: agg.countPaid,
      };
    })
    // Most recent period first.
    .sort((a, b) => (a.period_start < b.period_start ? 1 : -1));

  // Step 3: build the year filter list from distinct payroll_periods.period_start.
  const { data: yearRows } = await admin
    .from("payroll_periods")
    .select("period_start");
  const yearsSet = new Set<number>();
  for (const r of yearRows ?? []) {
    if (r.period_start && r.period_start.length >= 4) {
      yearsSet.add(Number.parseInt(r.period_start.slice(0, 4), 10));
    }
  }
  // Make sure the currently selected year is selectable even if there are no
  // periods in it yet (e.g. a freshly-installed prod).
  yearsSet.add(currentYear);
  yearsSet.add(year);
  const years = Array.from(yearsSet).sort((a, b) => b - a);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Pay runs
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          All payroll runs — drill in for DTR, deductions, and payout.
        </p>
      </header>

      <RunsClient
        runs={runs}
        years={years}
        currentYear={year}
        currentStatus={status}
      />
    </div>
  );
}
