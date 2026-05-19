import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  PeriodsClient,
  type PeriodRow,
  type RunByPeriod,
} from "./periods-client";

export const metadata = { title: "Pay periods — payroll admin" };
export const dynamic = "force-dynamic";

/**
 * Compute the next half-month pay period in Asia/Manila terms.
 *
 * Rule:
 *   - If today falls in days 1..15 of the current month, the *next* period is
 *     16 → (last day of the current month).
 *   - If today falls in days 16..eom of the current month, the *next* period is
 *     1 → 15 of the *following* month.
 *
 * Both bounds are returned as YYYY-MM-DD strings (Asia/Manila wall-clock).
 */
function nextHalfMonthFromManila(today: string): {
  start: string;
  end: string;
} {
  // today is YYYY-MM-DD in Manila.
  const [y, m, d] = today.split("-").map((v) => Number.parseInt(v, 10));
  const day = d;
  const month = m; // 1-12
  const year = y;
  const pad = (n: number) => String(n).padStart(2, "0");

  if (day <= 15) {
    // Second half of current month.
    const eom = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      start: `${year}-${pad(month)}-16`,
      end: `${year}-${pad(month)}-${pad(eom)}`,
    };
  }
  // First half of next month.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return {
    start: `${nextYear}-${pad(nextMonth)}-01`,
    end: `${nextYear}-${pad(nextMonth)}-15`,
  };
}

export default async function PayrollPeriodsPage() {
  await requireAdminStaff();

  // Service-role client so we don't have to wire up staff-RLS for these reads —
  // the page itself is already gated by requireAdminStaff().
  const admin = createAdminClient();

  const [periodsRes, runsRes] = await Promise.all([
    admin
      .from("payroll_periods")
      .select("id, period_start, period_end, status, created_at")
      .order("period_start", { ascending: false }),
    admin.from("payroll_runs").select("id, period_id, status"),
  ]);

  // Surface DB errors to the client banner instead of silently rendering empty
  // — admin needs to be able to tell "no data" from "query failed".
  const dbErrors: string[] = [];
  if (periodsRes.error) {
    console.error("[payroll/periods] periods query failed:", periodsRes.error);
    dbErrors.push("Failed to load pay periods.");
  }
  if (runsRes.error) {
    console.error("[payroll/periods] runs query failed:", runsRes.error);
    dbErrors.push("Failed to load runs.");
  }
  const errorMessage = dbErrors.length > 0 ? dbErrors.join(" ") : null;

  const periods: PeriodRow[] = (periodsRes.data ?? []).map((row) => ({
    id: row.id,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    created_at: row.created_at,
  }));

  const runByPeriod: RunByPeriod = {};
  for (const r of runsRes.data ?? []) {
    runByPeriod[r.period_id] = { id: r.id, status: r.status };
  }

  const today = todayManilaISODate();
  const { start: defaultStart, end: defaultEnd } = nextHalfMonthFromManila(
    today,
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Pay periods
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Half-month pay periods. Create the next period when reception
          finishes the cutoff.
        </p>
      </header>

      <PeriodsClient
        periods={periods}
        runByPeriod={runByPeriod}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
        error={errorMessage}
      />
    </div>
  );
}
