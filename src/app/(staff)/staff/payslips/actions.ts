"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";

type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export async function listMyPayslipsAction(): Promise<ActionResult<{
  payslips: Array<{
    id: string;
    period_start: string;
    period_end: string;
    pay_date: string;
    net_pay_php: number;
    payment_method_used: "cash" | "bank" | null;
    paid_at: string | null;
    payslip_file_path: string | null;
  }>;
}>> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();
  const { data: employee } = await admin
    .from("employees").select("id").eq("staff_profile_id", session.user_id).maybeSingle();
  if (!employee) return { ok: true, data: { payslips: [] } };

  const { data, error } = await admin
    .from("payroll_employee_runs")
    .select(`
      id, net_pay_php, payment_method_used, paid_at, payslip_file_path,
      payroll_runs!inner(period_id, payroll_periods!inner(period_start, period_end, pay_date))
    `)
    .eq("employee_id", employee.id)
    .order("paid_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) return { ok: false, error: translatePgError(error) };

  const payslips = (data ?? []).map((r) => {
    const period = (r.payroll_runs as { payroll_periods: { period_start: string; period_end: string; pay_date: string } }).payroll_periods;
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
  return { ok: true, data: { payslips } };
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
