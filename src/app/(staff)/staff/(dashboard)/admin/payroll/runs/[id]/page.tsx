import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  RunReviewClient,
  type EmployeeRunRow,
  type RunHeader,
  type EarningLineRow,
  type DeductionLineRow,
} from "./run-review-client";

export const metadata = { title: "Pay run — payroll admin" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RunReviewPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;

  const admin = createAdminClient();

  // Three parallel fetches: the run + its period, the per-employee rows with
  // their joined employee + staff_profile + line children, and the most-recent
  // DTR import for this period (used to drive the no-DTR banner).
  const [runRes, employeeRunsRes] = await Promise.all([
    admin
      .from("payroll_runs")
      .select(
        `id, period_id, status, computed_at, finalised_at, finalised_by,
         voided_at, voided_by, void_reason, created_at, notes,
         period:payroll_periods!inner(id, period_start, period_end, pay_date, status)`,
      )
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("payroll_employee_runs")
      .select(
        `id, run_id, employee_id, scheduled_days, days_present, days_vl_used,
         days_sl_used, days_unpaid_absent, basic_pay_php, allowances_total_php,
         ot_pay_php, night_diff_pay_php, holiday_pay_php, incentives_total_php,
         perfect_attendance_bonus_php, thirteenth_month_payout_php,
         gross_pay_php, sss_ee_php, philhealth_ee_php, pagibig_ee_php,
         wt_compensation_php, tardiness_deduction_php,
         staff_advance_settlement_php, other_deductions_total_php,
         net_pay_php, payout_status, payment_method_used, paid_at,
         ot_overage_unpaid_minutes_total, minutes_late_total, tardiness_count,
         missing_punch_days,
         employee:employees!inner(
           id, employee_number, schedule_kind, payment_method, staff_profile_id,
           staff_profile:staff_profiles!staff_profile_id(full_name)
         ),
         earnings:payroll_earning_lines(id, kind, label, amount_php, created_by, created_at),
         deductions:payroll_deduction_lines(id, kind, label, amount_php, loan_id, created_by, created_at)`,
      )
      .eq("run_id", id)
      .order("employee_id", { ascending: true }),
  ]);

  if (runRes.error) {
    console.error("[payroll/runs/[id]] run fetch failed:", runRes.error);
    notFound();
  }
  if (!runRes.data) {
    notFound();
  }

  const runRow = runRes.data;
  const periodJoin = Array.isArray(runRow.period)
    ? runRow.period[0]
    : runRow.period;
  if (!periodJoin) {
    // Should be unreachable — !inner join on a NOT NULL FK — but type-narrow.
    notFound();
  }

  // Look up the finaliser's full name if present. Cheap single-row read.
  let finaliserName: string | null = null;
  if (runRow.finalised_by) {
    const { data: finProfile } = await admin
      .from("staff_profiles")
      .select("full_name")
      .eq("id", runRow.finalised_by)
      .maybeSingle();
    finaliserName = finProfile?.full_name ?? null;
  }

  // Has any DTR been imported for this period? We don't track this on
  // payroll_runs directly; presence of a payroll_dtr_imports row keyed to the
  // period is the canonical signal.
  const { count: dtrCount } = await admin
    .from("payroll_dtr_imports")
    .select("id", { count: "exact", head: true })
    .eq("period_id", periodJoin.id);
  const dtrImported = (dtrCount ?? 0) > 0;

  // Reshape employee_run rows for the client component. PostgREST returns
  // to-one joins as either an object or a single-element array; type-narrow
  // both shapes defensively.
  const employeeRuns: EmployeeRunRow[] = (employeeRunsRes.data ?? []).map(
    (er) => {
      const emp = Array.isArray(er.employee) ? er.employee[0] : er.employee;
      const profile = emp
        ? Array.isArray(emp.staff_profile)
          ? emp.staff_profile[0]
          : emp.staff_profile
        : null;

      const earnings: EarningLineRow[] = (er.earnings ?? []).map((l) => ({
        id: l.id,
        kind: l.kind,
        label: l.label,
        amount_php: Number(l.amount_php),
        created_by: l.created_by,
        created_at: l.created_at,
      }));
      const deductions: DeductionLineRow[] = (er.deductions ?? []).map((l) => ({
        id: l.id,
        kind: l.kind,
        label: l.label,
        amount_php: Number(l.amount_php),
        loan_id: l.loan_id,
        created_by: l.created_by,
        created_at: l.created_at,
      }));

      return {
        id: er.id,
        run_id: er.run_id,
        employee_id: er.employee_id,
        full_name: profile?.full_name ?? "(unknown)",
        employee_number: emp?.employee_number ?? null,
        schedule_kind: emp?.schedule_kind ?? "",
        payment_method: (emp?.payment_method ?? "cash") as "cash" | "bank",
        scheduled_days: Number(er.scheduled_days ?? 0),
        days_present: Number(er.days_present ?? 0),
        days_vl_used: Number(er.days_vl_used ?? 0),
        days_sl_used: Number(er.days_sl_used ?? 0),
        days_unpaid_absent: Number(er.days_unpaid_absent ?? 0),
        basic_pay_php: Number(er.basic_pay_php ?? 0),
        allowances_total_php: Number(er.allowances_total_php ?? 0),
        ot_pay_php: Number(er.ot_pay_php ?? 0),
        night_diff_pay_php: Number(er.night_diff_pay_php ?? 0),
        holiday_pay_php: Number(er.holiday_pay_php ?? 0),
        incentives_total_php: Number(er.incentives_total_php ?? 0),
        perfect_attendance_bonus_php: Number(
          er.perfect_attendance_bonus_php ?? 0,
        ),
        thirteenth_month_payout_php: Number(
          er.thirteenth_month_payout_php ?? 0,
        ),
        gross_pay_php: Number(er.gross_pay_php ?? 0),
        sss_ee_php: Number(er.sss_ee_php ?? 0),
        philhealth_ee_php: Number(er.philhealth_ee_php ?? 0),
        pagibig_ee_php: Number(er.pagibig_ee_php ?? 0),
        wt_compensation_php: Number(er.wt_compensation_php ?? 0),
        tardiness_deduction_php: Number(er.tardiness_deduction_php ?? 0),
        staff_advance_settlement_php: Number(
          er.staff_advance_settlement_php ?? 0,
        ),
        other_deductions_total_php: Number(er.other_deductions_total_php ?? 0),
        net_pay_php: Number(er.net_pay_php ?? 0),
        payout_status: er.payout_status,
        payment_method_used: er.payment_method_used,
        paid_at: er.paid_at,
        ot_overage_unpaid_minutes_total: Number(
          er.ot_overage_unpaid_minutes_total ?? 0,
        ),
        minutes_late_total: Number(er.minutes_late_total ?? 0),
        tardiness_count: Number(er.tardiness_count ?? 0),
        missing_punch_days: Number(er.missing_punch_days ?? 0),
        earnings,
        deductions,
      };
    },
  );

  // Aggregate totals computed in JS (Postgres has no helper view for this yet).
  let sumGross = 0;
  let sumNet = 0;
  let sumStatutoryAndWt = 0;
  let countPaid = 0;
  for (const er of employeeRuns) {
    sumGross += er.gross_pay_php;
    sumNet += er.net_pay_php;
    sumStatutoryAndWt +=
      er.sss_ee_php +
      er.philhealth_ee_php +
      er.pagibig_ee_php +
      er.wt_compensation_php;
    if (er.payout_status === "paid") countPaid += 1;
  }

  const run: RunHeader = {
    id: runRow.id,
    period_id: runRow.period_id,
    status: runRow.status,
    computed_at: runRow.computed_at,
    finalised_at: runRow.finalised_at,
    finalised_by: runRow.finalised_by,
    voided_at: runRow.voided_at,
    void_reason: runRow.void_reason,
    period_start: periodJoin.period_start,
    period_end: periodJoin.period_end,
    pay_date: periodJoin.pay_date,
    period_status: periodJoin.status,
    finaliser_name: finaliserName,
    dtr_imported: dtrImported,
    sum_gross_php: sumGross,
    sum_net_php: sumNet,
    sum_statutory_and_wt_php: sumStatutoryAndWt,
    employee_count: employeeRuns.length,
    paid_count: countPaid,
  };

  return <RunReviewClient run={run} employeeRuns={employeeRuns} />;
}
