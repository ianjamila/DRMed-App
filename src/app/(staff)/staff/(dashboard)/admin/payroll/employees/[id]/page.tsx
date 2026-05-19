import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  EmployeeDetailClient,
  type EmployeeDetail,
  type AllowanceRow,
  type LoanRow,
  type OtSlipRow,
  type PeriodOption,
  type EmployeeRunHistoryRow,
} from "./employee-detail-client";

export const metadata = { title: "Employee — payroll admin" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EmployeeDetailPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;

  const admin = createAdminClient();

  const [
    employeeRes,
    allowancesRes,
    loansRes,
    otSlipsRes,
    vlBalanceRes,
    slBalanceRes,
    runsRes,
    periodsRes,
  ] = await Promise.all([
    admin
      .from("employees")
      .select(
        "id, employee_number, hire_date, regularization_date, termination_date, basic_daily_rate_php, schedule_kind, payment_method, is_active, staff_profile_id, staff_profiles:staff_profile_id(full_name, role)",
      )
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("employee_allowances")
      .select(
        "id, employee_id, name, daily_amount_php, is_taxable, effective_from, effective_to",
      )
      .eq("employee_id", id)
      .order("effective_from", { ascending: false }),
    admin
      .from("employee_loans")
      .select(
        "id, principal_php, amortization_per_period_php, outstanding_balance_php, status, notes, requested_at, approved_at, disbursed_at, start_period_id",
      )
      .eq("employee_id", id)
      .order("requested_at", { ascending: false }),
    admin
      .from("payroll_ot_slips")
      .select(
        "id, work_date, hours_requested, status, reason, requested_at, decided_at, decision_notes",
      )
      .eq("employee_id", id)
      .order("requested_at", { ascending: false })
      .limit(30),
    admin.rpc("employee_leave_balance", { p_employee_id: id, p_kind: "VL" }),
    admin.rpc("employee_leave_balance", { p_employee_id: id, p_kind: "SL" }),
    admin
      .from("payroll_employee_runs")
      .select(
        "id, run_id, days_present, days_vl_used, days_sl_used, scheduled_days, basic_pay_php, gross_pay_php, net_pay_php, payroll_runs!inner(period_id, status, payroll_periods!inner(period_start, period_end))",
      )
      .eq("employee_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Periods eligible to be the start period for a loan disbursement: open ones.
    admin
      .from("payroll_periods")
      .select("id, period_start, period_end, status")
      .eq("status", "open")
      .order("period_start", { ascending: true }),
  ]);

  if (!employeeRes.data) notFound();

  const row = employeeRes.data;
  const profile = Array.isArray(row.staff_profiles)
    ? row.staff_profiles[0]
    : row.staff_profiles;

  const employee: EmployeeDetail = {
    id: row.id,
    employee_number: row.employee_number,
    hire_date: row.hire_date,
    regularization_date: row.regularization_date,
    termination_date: row.termination_date,
    basic_daily_rate_php: Number(row.basic_daily_rate_php),
    schedule_kind: row.schedule_kind,
    payment_method: row.payment_method,
    is_active: row.is_active,
    full_name: profile?.full_name ?? "Unknown",
    role: profile?.role ?? null,
  };

  const allowances: AllowanceRow[] = (allowancesRes.data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    daily_amount_php: Number(a.daily_amount_php),
    is_taxable: a.is_taxable,
    effective_from: a.effective_from,
    effective_to: a.effective_to,
  }));

  const loans: LoanRow[] = (loansRes.data ?? []).map((l) => ({
    id: l.id,
    principal_php: Number(l.principal_php),
    amortization_per_period_php: Number(l.amortization_per_period_php),
    outstanding_balance_php: Number(l.outstanding_balance_php),
    status: l.status,
    notes: l.notes,
    requested_at: l.requested_at,
    approved_at: l.approved_at,
    disbursed_at: l.disbursed_at,
    start_period_id: l.start_period_id,
  }));

  const otSlips: OtSlipRow[] = (otSlipsRes.data ?? []).map((s) => ({
    id: s.id,
    work_date: s.work_date,
    hours_requested: Number(s.hours_requested),
    status: s.status,
    reason: s.reason,
    requested_at: s.requested_at,
    decided_at: s.decided_at,
    decision_notes: s.decision_notes,
  }));

  const runHistory: EmployeeRunHistoryRow[] = (runsRes.data ?? []).map(
    (r) => {
      const runJoin = Array.isArray(r.payroll_runs)
        ? r.payroll_runs[0]
        : r.payroll_runs;
      const periodJoin = runJoin
        ? Array.isArray(runJoin.payroll_periods)
          ? runJoin.payroll_periods[0]
          : runJoin.payroll_periods
        : null;
      return {
        id: r.id,
        run_id: r.run_id,
        run_status: runJoin?.status ?? null,
        period_start: periodJoin?.period_start ?? null,
        period_end: periodJoin?.period_end ?? null,
        scheduled_days: Number(r.scheduled_days ?? 0),
        days_present: Number(r.days_present ?? 0),
        days_vl_used: Number(r.days_vl_used ?? 0),
        days_sl_used: Number(r.days_sl_used ?? 0),
        basic_pay_php: Number(r.basic_pay_php ?? 0),
        gross_pay_php: Number(r.gross_pay_php ?? 0),
        net_pay_php: Number(r.net_pay_php ?? 0),
      };
    },
  );

  const vlBalance = Number(vlBalanceRes.data ?? 0);
  const slBalance = Number(slBalanceRes.data ?? 0);

  const periodOptions: PeriodOption[] = (periodsRes.data ?? []).map((p) => ({
    id: p.id,
    period_start: p.period_start,
    period_end: p.period_end,
  }));

  return (
    <EmployeeDetailClient
      employee={employee}
      allowances={allowances}
      loans={loans}
      otSlips={otSlips}
      vlBalance={vlBalance}
      slBalance={slBalance}
      runHistory={runHistory}
      periodOptions={periodOptions}
    />
  );
}
