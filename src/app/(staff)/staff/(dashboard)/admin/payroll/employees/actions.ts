"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CreateEmployeeSchema,
  UpdateEmployeeSchema,
  AddAllowanceSchema,
  RequestLoanSchema,
  ApproveLoanSchema,
  MarkLoanDisbursedSchema,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
  type AddAllowanceInput,
  type RequestLoanInput,
  type ApproveLoanInput,
  type MarkLoanDisbursedInput,
} from "@/lib/validations/accounting";

export type EmployeeActionResult =
  | { ok: true }
  | { ok: false; error: string };

const EMPLOYEES_PATH = "/staff/admin/payroll/employees";

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

function firstIssue(err: z.ZodError, fallback = "Please check the form."): string {
  return err.issues[0]?.message ?? fallback;
}

// ----- Employees ---------------------------------------------------------

export async function createEmployeeAction(
  raw: CreateEmployeeInput,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = CreateEmployeeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("employees")
    .insert(parsed.data)
    .select("id, staff_profile_id, employee_number")
    .single();
  if (error || !created) {
    return { ok: false, error: error ? translatePgError(error) : "Could not create employee." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.created",
    resource_type: "employee",
    resource_id: created.id,
    metadata: {
      staff_profile_id: created.staff_profile_id,
      employee_number: created.employee_number,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  return { ok: true };
}

export async function updateEmployeeAction(
  id: string,
  raw: Omit<UpdateEmployeeInput, "id">,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = UpdateEmployeeSchema.safeParse({ ...raw, id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  // Strip `id` out of the payload; the rest is the update set.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, ...updateFields } = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("employees")
    .update(updateFields)
    .eq("id", id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  // Note: when `termination_date` is set on this update, leave forfeiture
  // is handled separately by the leaves actions file in Task 52.

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.updated",
    resource_type: "employee",
    resource_id: id,
    metadata: { fields: Object.keys(updateFields) },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${id}`);
  return { ok: true };
}

export async function deactivateEmployeeAction(
  id: string,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  if (!id || typeof id !== "string") {
    return { ok: false, error: "Employee id is required." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("employees")
    .update({ is_active: false })
    .eq("id", id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.deactivated",
    resource_type: "employee",
    resource_id: id,
    metadata: null,
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${id}`);
  return { ok: true };
}

// ----- Allowances --------------------------------------------------------

export async function addAllowanceAction(
  raw: AddAllowanceInput,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = AddAllowanceSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("employee_allowances")
    .insert(parsed.data)
    .select("id, employee_id, name")
    .single();
  if (error || !created) {
    return { ok: false, error: error ? translatePgError(error) : "Could not add allowance." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.allowance_added",
    resource_type: "employee_allowance",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      name: created.name,
      daily_amount_php: parsed.data.daily_amount_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${created.employee_id}`);
  return { ok: true };
}

const EndAllowanceSchema = z.object({
  id: z.string().uuid(),
  effective_to: z.string().min(1, "effective_to is required."),
});

export async function endAllowanceAction(
  id: string,
  effective_to: string,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = EndAllowanceSchema.safeParse({ id, effective_to });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("employee_allowances")
    .update({ effective_to: parsed.data.effective_to })
    .eq("id", parsed.data.id)
    .select("id, employee_id, name")
    .single();
  if (error || !updated) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Allowance not found.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.allowance_ended",
    resource_type: "employee_allowance",
    resource_id: updated.id,
    metadata: {
      employee_id: updated.employee_id,
      name: updated.name,
      effective_to: parsed.data.effective_to,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${updated.employee_id}`);
  return { ok: true };
}

// ----- Loans -------------------------------------------------------------

export async function requestLoanAction(
  raw: RequestLoanInput,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = RequestLoanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("employee_loans")
    .insert({
      employee_id: parsed.data.employee_id,
      principal_php: parsed.data.principal_php,
      amortization_per_period_php: parsed.data.amortization_per_period_php,
      notes: parsed.data.notes ?? null,
      // Spec: initialise outstanding to the principal on request.
      outstanding_balance_php: parsed.data.principal_php,
      status: "requested",
      requested_by: session.user_id,
    })
    .select("id, employee_id")
    .single();
  if (error || !created) {
    return { ok: false, error: error ? translatePgError(error) : "Could not request loan." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.loan_requested",
    resource_type: "employee_loan",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      principal_php: parsed.data.principal_php,
      amortization_per_period_php: parsed.data.amortization_per_period_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${created.employee_id}`);
  return { ok: true };
}

export async function approveLoanAction(
  raw: ApproveLoanInput,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = ApproveLoanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // State-machine guard: must be 'requested' before approve.
  const { data: existing, error: fetchErr } = await admin
    .from("employee_loans")
    .select("id, status, employee_id")
    .eq("id", parsed.data.loan_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Loan not found." };
  }
  if (existing.status !== "requested") {
    return { ok: false, error: "Loan must be in 'requested' status." };
  }

  const { error } = await admin
    .from("employee_loans")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: session.user_id,
      approval_notes: parsed.data.approval_notes ?? null,
    })
    .eq("id", parsed.data.loan_id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.loan_approved",
    resource_type: "employee_loan",
    resource_id: parsed.data.loan_id,
    metadata: { employee_id: existing.employee_id },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${existing.employee_id}`);
  return { ok: true };
}

export async function markLoanDisbursedAction(
  raw: MarkLoanDisbursedInput,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = MarkLoanDisbursedSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("employee_loans")
    .select("id, status, employee_id")
    .eq("id", parsed.data.loan_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Loan not found." };
  }
  if (existing.status !== "approved") {
    return { ok: false, error: "Loan must be in 'approved' status." };
  }

  const { error } = await admin
    .from("employee_loans")
    .update({
      status: "active",
      disbursed_at: new Date().toISOString(),
      disbursed_by: session.user_id,
      start_period_id: parsed.data.start_period_id,
    })
    .eq("id", parsed.data.loan_id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.loan_disbursed",
    resource_type: "employee_loan",
    resource_id: parsed.data.loan_id,
    metadata: {
      employee_id: existing.employee_id,
      start_period_id: parsed.data.start_period_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${existing.employee_id}`);
  return { ok: true };
}

const VoidLoanSchema = z.object({
  id: z.string().uuid(),
  void_reason: z.string().trim().min(1, "Reason is required.").max(500),
});

export async function voidLoanAction(
  id: string,
  void_reason: string,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = VoidLoanSchema.safeParse({ id, void_reason });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // The DB doesn't have a dedicated voided_at column on employee_loans, so the
  // audit_log row is the canonical record of who/when/why.
  const { data: existing, error: fetchErr } = await admin
    .from("employee_loans")
    .select("id, status, employee_id")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Loan not found." };
  }
  if (
    existing.status === "voided" ||
    existing.status === "written_off" ||
    existing.status === "paid_off"
  ) {
    return { ok: false, error: "Loan is already in a terminal state." };
  }

  const stamp = new Date().toISOString();
  const { error } = await admin
    .from("employee_loans")
    .update({ status: "voided" })
    .eq("id", parsed.data.id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.loan_voided",
    resource_type: "employee_loan",
    resource_id: parsed.data.id,
    metadata: {
      employee_id: existing.employee_id,
      void_reason: parsed.data.void_reason,
      voided_at: stamp,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${existing.employee_id}`);
  return { ok: true };
}

const WriteOffLoanSchema = z.object({
  id: z.string().uuid(),
  write_off_reason: z.string().trim().min(1, "Reason is required.").max(500),
});

export async function writeOffLoanAction(
  id: string,
  write_off_reason: string,
): Promise<EmployeeActionResult> {
  const session = await requireAdminStaff();
  const parsed = WriteOffLoanSchema.safeParse({ id, write_off_reason });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // No dedicated written_off_at column on the table; the audit_log row holds
  // the canonical timestamp.
  const { data: existing, error: fetchErr } = await admin
    .from("employee_loans")
    .select("id, status, employee_id")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Loan not found." };
  }
  if (existing.status !== "active") {
    return { ok: false, error: "Only active loans can be written off." };
  }

  const stamp = new Date().toISOString();
  const { error } = await admin
    .from("employee_loans")
    .update({ status: "written_off" })
    .eq("id", parsed.data.id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "employee.loan_written_off",
    resource_type: "employee_loan",
    resource_id: parsed.data.id,
    metadata: {
      employee_id: existing.employee_id,
      write_off_reason: parsed.data.write_off_reason,
      written_off_at: stamp,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(EMPLOYEES_PATH);
  revalidatePath(`${EMPLOYEES_PATH}/${existing.employee_id}`);
  return { ok: true };
}
