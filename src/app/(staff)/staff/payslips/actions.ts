"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { audit } from "@/lib/audit/log";

type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export type PayslipListItem = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  net_pay_php: number;
  payment_method_used: "cash" | "bank" | null;
  paid_at: string | null;
  payslip_file_path: string | null;
};

export type ListMyPayslipsArgs = {
  /** Admin-only: view another employee's payslips. Non-admins are silently ignored. */
  employee_id?: string;
  /** Optional 4-digit year filter (e.g. 2026). Filters on payroll_periods.pay_date. */
  year?: number;
};

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

/**
 * Returns the calling employee's own payslips by default. Admins may pass an
 * `employee_id` to view another employee's payslips; the cross-employee view
 * is audit-logged. Non-admins passing `employee_id` have the param silently
 * ignored. Backward-compatible: the no-argument call still returns the
 * caller's own payslips.
 */
export async function listMyPayslipsAction(
  args: ListMyPayslipsArgs = {},
): Promise<ActionResult<{ payslips: PayslipListItem[] }>> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  // Resolve the target employee row.
  let targetEmployeeId: string | null = null;
  let crossEmployee = false;

  if (args.employee_id && session.role === "admin") {
    const { data: target } = await admin
      .from("employees")
      .select("id, staff_profile_id")
      .eq("id", args.employee_id)
      .maybeSingle();
    if (!target) return { ok: true, data: { payslips: [] } };
    targetEmployeeId = target.id;
    crossEmployee = target.staff_profile_id !== session.user_id;
  } else {
    const { data: employee } = await admin
      .from("employees")
      .select("id")
      .eq("staff_profile_id", session.user_id)
      .maybeSingle();
    if (!employee) return { ok: true, data: { payslips: [] } };
    targetEmployeeId = employee.id;
  }

  // Cross-employee view by admin → audit it.
  if (crossEmployee && targetEmployeeId) {
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payslip.admin_viewed_other_employee_list",
      resource_type: "employee",
      resource_id: targetEmployeeId,
      metadata: { year: args.year ?? null },
      ip_address: ip,
      user_agent: ua,
    });
  }

  const { data, error } = await admin
    .from("payroll_employee_runs")
    .select(`
      id, net_pay_php, payment_method_used, paid_at, payslip_file_path,
      payroll_runs!inner(period_id, payroll_periods!inner(period_start, period_end, pay_date))
    `)
    .eq("employee_id", targetEmployeeId)
    .order("paid_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) return { ok: false, error: translatePgError(error) };

  let payslips: PayslipListItem[] = (data ?? []).map((r) => {
    const period = (
      r.payroll_runs as {
        payroll_periods: {
          period_start: string;
          period_end: string;
          pay_date: string;
        };
      }
    ).payroll_periods;
    return {
      id: r.id,
      period_start: period.period_start,
      period_end: period.period_end,
      pay_date: period.pay_date,
      net_pay_php: Number(r.net_pay_php),
      payment_method_used: r.payment_method_used as "cash" | "bank" | null,
      paid_at: r.paid_at,
      payslip_file_path: r.payslip_file_path,
    };
  });

  if (typeof args.year === "number" && Number.isFinite(args.year)) {
    const y = args.year;
    payslips = payslips.filter((p) => {
      const py = Number(p.pay_date.slice(0, 4));
      return py === y;
    });
  }

  return { ok: true, data: { payslips } };
}

export type YtdTotals = {
  gross_pay_php: number;
  total_deductions_php: number;
  net_pay_php: number;
  payslip_count: number;
};

/**
 * Year-to-date totals across PAID payroll_employee_runs for the year. Sums
 * gross pay, total deductions (everything between gross and net), and net pay.
 * Admin may pass `employee_id` to view another employee's totals (silently
 * ignored for non-admins). No audit here — the list action already audited.
 */
export async function getMyYtdTotalsAction(
  args: { year?: number; employee_id?: string } = {},
): Promise<ActionResult<{ ytd: YtdTotals; year: number }>> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  const year = args.year ?? new Date().getFullYear();

  let targetEmployeeId: string | null = null;
  if (args.employee_id && session.role === "admin") {
    const { data: target } = await admin
      .from("employees")
      .select("id")
      .eq("id", args.employee_id)
      .maybeSingle();
    targetEmployeeId = target?.id ?? null;
  } else {
    const { data: employee } = await admin
      .from("employees")
      .select("id")
      .eq("staff_profile_id", session.user_id)
      .maybeSingle();
    targetEmployeeId = employee?.id ?? null;
  }

  if (!targetEmployeeId) {
    return {
      ok: true,
      data: {
        ytd: {
          gross_pay_php: 0,
          total_deductions_php: 0,
          net_pay_php: 0,
          payslip_count: 0,
        },
        year,
      },
    };
  }

  const { data, error } = await admin
    .from("payroll_employee_runs")
    .select(`
      gross_pay_php, net_pay_php,
      payroll_runs!inner(payroll_periods!inner(pay_date))
    `)
    .eq("employee_id", targetEmployeeId)
    .not("paid_at", "is", null);
  if (error) return { ok: false, error: translatePgError(error) };

  let gross = 0;
  let net = 0;
  let count = 0;
  for (const row of data ?? []) {
    const period = (
      row.payroll_runs as { payroll_periods: { pay_date: string } }
    ).payroll_periods;
    const py = Number(period.pay_date.slice(0, 4));
    if (py !== year) continue;
    gross += Number(row.gross_pay_php);
    net += Number(row.net_pay_php);
    count += 1;
  }

  return {
    ok: true,
    data: {
      ytd: {
        gross_pay_php: gross,
        total_deductions_php: gross - net,
        net_pay_php: net,
        payslip_count: count,
      },
      year,
    },
  };
}

export type EmployeePayslipAdminOption = {
  id: string;
  full_name: string;
  employee_number: string | null;
};

/**
 * Admin-only: list all employees (with name + employee number) for the
 * payslip admin dropdown. Returns an empty array for non-admins.
 */
export async function listEmployeesForPayslipAdminAction(): Promise<
  ActionResult<{ employees: EmployeePayslipAdminOption[] }>
> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: true, data: { employees: [] } };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employees")
    .select("id, employee_number, staff_profiles:staff_profile_id(full_name)")
    .order("employee_number", { ascending: true });
  if (error) return { ok: false, error: translatePgError(error) };

  const employees: EmployeePayslipAdminOption[] = (data ?? [])
    .map((row) => {
      const profile = Array.isArray(row.staff_profiles)
        ? row.staff_profiles[0]
        : row.staff_profiles;
      return {
        id: row.id,
        full_name: profile?.full_name ?? "Unknown",
        employee_number: row.employee_number ?? null,
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  return { ok: true, data: { employees } };
}

export async function getPayslipUrlAction(employee_run_id: string): Promise<ActionResult<{ url: string }>> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();
  const { data: er, error: erErr } = await admin
    .from("payroll_employee_runs")
    .select("employee_id, payslip_file_path, employees!inner(staff_profile_id)")
    .eq("id", employee_run_id)
    .maybeSingle();
  if (erErr || !er) return { ok: false, error: "Payslip not found." };
  const isOwn = (er.employees as { staff_profile_id: string }).staff_profile_id === session.user_id;
  const isAdmin = session.role === "admin";
  if (!isOwn && !isAdmin) return { ok: false, error: "Forbidden." };
  if (!er.payslip_file_path) return { ok: false, error: "Payslip not yet generated." };

  const { data: signed, error: signedErr } = await admin.storage
    .from("payslips").createSignedUrl(er.payslip_file_path, 300);
  if (signedErr) return { ok: false, error: translatePgError(signedErr) };
  return { ok: true, data: { url: signed.signedUrl } };
}
