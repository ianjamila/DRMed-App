import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { LeavesClient, type LeaveRow } from "./leaves-client";

export const metadata = { title: "Leaves — payroll admin" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function PayrollLeavesPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayManila = todayManilaISODate();
  const currentYear = Number.parseInt(todayManila.slice(0, 4), 10);

  // Loosely validate the ?year= param. Anything implausible falls back to
  // the current Manila year so a junk query string can't break the page.
  const yearParam = sp.year ? Number.parseInt(sp.year, 10) : currentYear;
  const year =
    Number.isFinite(yearParam) && yearParam >= 1900 && yearParam <= 2999
      ? yearParam
      : currentYear;

  // Service-role client: page is gated by requireAdminStaff() above. A single
  // tabular admin view is easier to maintain without wrestling RLS for every
  // read, and the consumption + grant aggregates need to cross all employees.
  const admin = createAdminClient();

  let dbError: string | null = null;

  // 1) Active employees + joined staff_profiles.full_name. We restrict to
  //    is_active = true here because this dashboard is for current rosters
  //    only — inactive employees still surface their leave history via
  //    the per-employee detail page.
  const { data: employeeRows, error: empError } = await admin
    .from("employees")
    .select(
      "id, employee_number, is_active, staff_profiles:staff_profile_id(full_name)",
    )
    .eq("is_active", true);
  if (empError) {
    console.error("[payroll/leaves] employees query failed:", empError);
    dbError = "Failed to load employees.";
  }

  type EmployeeBase = {
    id: string;
    employee_number: string | null;
    full_name: string;
  };
  const employees: EmployeeBase[] = (employeeRows ?? [])
    .map((row) => {
      const profile = Array.isArray(row.staff_profiles)
        ? row.staff_profiles[0]
        : row.staff_profiles;
      return {
        id: row.id,
        employee_number: row.employee_number,
        full_name: profile?.full_name ?? "Unknown",
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  // 2) Per-employee VL + SL balances at today's Manila date.
  type BalancePair = { vl: number; sl: number };
  const balancePairs = new Map<string, BalancePair>();
  if (!dbError && employees.length > 0) {
    // Fan out balance RPCs. Two calls per employee (VL + SL). Each RPC is a
    // single SUM(days_delta) so the cost stays linear; we keep them parallel.
    const balanceResults = await Promise.all(
      employees.flatMap((e) => [
        admin
          .rpc("employee_leave_balance", {
            p_employee_id: e.id,
            p_kind: "VL",
            p_as_of_date: todayManila,
          })
          .then((r) => ({ employee_id: e.id, kind: "VL" as const, result: r })),
        admin
          .rpc("employee_leave_balance", {
            p_employee_id: e.id,
            p_kind: "SL",
            p_as_of_date: todayManila,
          })
          .then((r) => ({ employee_id: e.id, kind: "SL" as const, result: r })),
      ]),
    );
    for (const { employee_id, kind, result } of balanceResults) {
      if (result.error) {
        console.error(
          `[payroll/leaves] balance ${kind} failed for ${employee_id}:`,
          result.error,
        );
        continue;
      }
      const current = balancePairs.get(employee_id) ?? { vl: 0, sl: 0 };
      const value = Number(result.data ?? 0);
      if (kind === "VL") {
        current.vl = Number.isFinite(value) ? value : 0;
      } else {
        current.sl = Number.isFinite(value) ? value : 0;
      }
      balancePairs.set(employee_id, current);
    }
  }

  // 3) Days used this year, grouped in JS. record_kind = 'usage' has a
  //    negative days_delta per the CHECK constraint (0044); we sum the
  //    absolute values to get total days consumed.
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;
  const usedByEmployee = new Map<string, number>();
  if (!dbError) {
    const { data: usageRows, error: usageErr } = await admin
      .from("employee_leave_records")
      .select("employee_id, days_delta")
      .eq("record_kind", "usage")
      .gte("effective_date", yearStart)
      .lt("effective_date", yearEnd);
    if (usageErr) {
      console.error("[payroll/leaves] usage query failed:", usageErr);
      dbError = "Failed to load leave usage.";
    } else {
      for (const row of usageRows ?? []) {
        const prior = usedByEmployee.get(row.employee_id) ?? 0;
        usedByEmployee.set(
          row.employee_id,
          prior + Math.abs(Number(row.days_delta) || 0),
        );
      }
    }
  }

  // 4) Next expiry date per employee — earliest non-elapsed expiry_date on
  //    positive-delta rows (entitlements / manual_grants). We pull all
  //    positive rows with expiry_date >= today, reduce client-side to the
  //    min per employee. Expired rows are uninteresting because the bulk
  //    apply_leave_expiry() RPC has already flipped them into 'expiry' rows.
  const nextExpiryByEmployee = new Map<string, string>();
  if (!dbError) {
    const { data: expiryRows, error: expiryErr } = await admin
      .from("employee_leave_records")
      .select("employee_id, expiry_date")
      .gt("days_delta", 0)
      .not("expiry_date", "is", null)
      .gte("expiry_date", todayManila);
    if (expiryErr) {
      console.error("[payroll/leaves] expiry query failed:", expiryErr);
      dbError = "Failed to load leave expiries.";
    } else {
      for (const row of expiryRows ?? []) {
        if (!row.expiry_date) continue;
        const prior = nextExpiryByEmployee.get(row.employee_id);
        if (!prior || row.expiry_date < prior) {
          nextExpiryByEmployee.set(row.employee_id, row.expiry_date);
        }
      }
    }
  }

  // Build the typed row shape used by the client.
  const rows: LeaveRow[] = employees.map((e) => {
    const balances = balancePairs.get(e.id) ?? { vl: 0, sl: 0 };
    return {
      employee_id: e.id,
      employee_number: e.employee_number,
      full_name: e.full_name,
      vl_balance: balances.vl,
      sl_balance: balances.sl,
      days_used_this_year: usedByEmployee.get(e.id) ?? 0,
      next_expiry_date: nextExpiryByEmployee.get(e.id) ?? null,
    };
  });

  // Synthetic 4-year window centred on "now". Always include `year` itself
  // so a hand-typed ?year=... outside the window remains a valid option.
  const yearsSet = new Set<number>([
    currentYear - 1,
    currentYear,
    currentYear + 1,
    currentYear + 2,
    year,
  ]);
  const years = Array.from(yearsSet).sort((a, b) => a - b);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Leave dashboard
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Cross-employee view of VL and SL balances, year-to-date usage and the
          next pending expiry. Use the per-row actions to record manual grants,
          usage or cash conversions; the per-employee detail page still works
          for one-employee deep-dives.
        </p>
      </header>

      <LeavesClient
        rows={rows}
        years={years}
        currentYear={year}
        todayManila={todayManila}
        error={dbError}
      />
    </div>
  );
}
