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

  // Track DB errors to surface to the admin instead of silently rendering
  // an empty table.
  const dbErrors: string[] = [];

  // Step A: fetch the period ids in the target year directly off
  // payroll_periods. PostgREST does NOT honour `period.period_start` filters
  // against an aliased embedded resource via supabase-js — the filter is
  // silently dropped and ALL runs come back regardless of ?year=. So we
  // resolve the period ids first, then filter runs by those ids.
  const { data: periodRows, error: periodIdsErr } = await admin
    .from("payroll_periods")
    .select("id")
    .gte("period_start", yearStart)
    .lt("period_start", yearEnd);
  if (periodIdsErr) {
    console.error(
      "[payroll/runs] periods-for-year query failed:",
      periodIdsErr,
    );
    dbErrors.push("Failed to load pay periods.");
  }
  const periodIds = (periodRows ?? []).map((p) => p.id);

  type RawRunRow = {
    id: string;
    status: string;
    created_at: string;
    period:
      | {
          id: string;
          period_start: string;
          period_end: string;
          pay_date: string;
        }
      | {
          id: string;
          period_start: string;
          period_end: string;
          pay_date: string;
        }[]
      | null;
  };

  // Step B: fetch runs by those period ids. Short-circuit when there are no
  // periods in the year so we don't issue an empty IN-list query.
  let rawRuns: RawRunRow[] = [];
  if (periodIds.length > 0) {
    let runsQuery = admin
      .from("payroll_runs")
      .select(
        "id, status, created_at, period:payroll_periods!inner(id, period_start, period_end, pay_date)",
      )
      .in("period_id", periodIds);

    if (status !== "all") {
      runsQuery = runsQuery.eq("status", status);
    }

    const { data, error: runsErr } = await runsQuery;
    if (runsErr) {
      console.error("[payroll/runs] runs query failed:", runsErr);
      dbErrors.push("Failed to load pay runs.");
    }
    rawRuns = (data ?? []) as RawRunRow[];
  }

  // Step C: aggregate payroll_employee_runs for the selected run ids. The
  // IN-list is sent in the URL, so chunk it to stay under PostgREST's URL
  // limits (~50 UUIDs is a comfortable ceiling).
  const runIds = rawRuns.map((r) => r.id);
  type EmpAgg = {
    sumGross: number;
    sumNet: number;
    countTotal: number;
    countPaid: number;
  };
  const aggByRun = new Map<string, EmpAgg>();
  if (runIds.length > 0) {
    const CHUNK = 30;
    const chunks: string[][] = [];
    for (let i = 0; i < runIds.length; i += CHUNK) {
      chunks.push(runIds.slice(i, i + CHUNK));
    }
    const empResults = await Promise.all(
      chunks.map((ids) =>
        admin
          .from("payroll_employee_runs")
          .select("run_id, gross_pay_php, net_pay_php, payout_status")
          .in("run_id", ids),
      ),
    );
    for (const res of empResults) {
      if (res.error) {
        console.error(
          "[payroll/runs] employee_runs chunk query failed:",
          res.error,
        );
        dbErrors.push("Failed to load run aggregates.");
        continue;
      }
      for (const row of res.data ?? []) {
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
  }

  // Shape rows for the client; PostgREST may return the to-one join as an
  // object or as a single-element array depending on the generated type.
  const runs: RunListRow[] = rawRuns
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

  // Step D: build the year filter list. Payroll history is bounded (started
  // 2026), so use a 5-year synthetic window centred on the current Manila
  // year instead of issuing a dedicated query just for the dropdown.
  const yearsSet = new Set<number>([
    currentYear - 2,
    currentYear - 1,
    currentYear,
    currentYear + 1,
    currentYear + 2,
    // Always include the currently selected year so it's a valid option even
    // when it falls outside the synthetic window.
    year,
  ]);
  const years = Array.from(yearsSet).sort((a, b) => b - a);

  // De-dup error messages so we don't spam the banner if multiple chunks fail.
  const uniqueErrors = Array.from(new Set(dbErrors));
  const errorMessage = uniqueErrors.length > 0 ? uniqueErrors.join(" ") : null;

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
        error={errorMessage}
      />
    </div>
  );
}
