"use server";

// Server Actions for payroll configuration:
//   * OT slips (request/approve/reject/void)
//   * Holidays (add/remove)
//   * Contribution brackets (SSS/PhilHealth/Pag-IBIG — create/end)
//   * Withholding-tax brackets (create/end)
//   * Payroll-related accounting_settings (upsert)
//
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §13.

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CreateOtSlipSchema,
  AddHolidaySchema,
  CreateContributionBracketSchema,
  CreateWtBracketSchema,
  UpdatePayrollSettingSchema,
  type CreateOtSlipInput,
  type AddHolidayInput,
  type CreateContributionBracketInput,
  type CreateWtBracketInput,
  type UpdatePayrollSettingInput,
} from "@/lib/validations/accounting";

export type ConfigActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const CONFIG_PATH = "/staff/admin/payroll/config";

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

// =============================================================================
// OT slips
// =============================================================================

export async function createOtSlipAction(
  input: CreateOtSlipInput,
): Promise<ConfigActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateOtSlipSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_ot_slips")
    .insert({
      employee_id: parsed.data.employee_id,
      work_date: parsed.data.work_date,
      hours_requested: parsed.data.hours_requested,
      reason: parsed.data.reason ?? null,
      // status defaults to 'pending' per migration 0044.
    })
    .select("id, employee_id, work_date, hours_requested")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create OT slip.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_ot_slip.requested",
    resource_type: "payroll_ot_slip",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      work_date: created.work_date,
      hours_requested: created.hours_requested,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: { id: created.id } };
}

const ApproveOtSlipSchema = z.object({
  slip_id: z.string().uuid(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function approveOtSlipAction(
  slip_id: string,
  notes?: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = ApproveOtSlipSchema.safeParse({ slip_id, notes });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Fetch-then-decide so the error message can be specific (voided vs already
  // decided vs missing). Mirrors voidOtSlipAction.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_ot_slips")
    .select("id, status, employee_id, work_date")
    .eq("id", parsed.data.slip_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "OT slip not found." };
  }
  if (existing.status === "voided") {
    return { ok: false, error: "OT slip is voided. It can't be approved." };
  }
  if (existing.status !== "pending") {
    return { ok: false, error: `OT slip is already ${existing.status}.` };
  }

  const { data: updated, error } = await admin
    .from("payroll_ot_slips")
    .update({
      status: "approved",
      decided_at: new Date().toISOString(),
      decided_by: session.user_id,
      decision_notes: parsed.data.notes ?? null,
    })
    .eq("id", parsed.data.slip_id)
    .select("id, employee_id, work_date")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "OT slip not found." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_ot_slip.approved",
    resource_type: "payroll_ot_slip",
    resource_id: updated.id,
    metadata: {
      employee_id: updated.employee_id,
      work_date: updated.work_date,
      notes: parsed.data.notes ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

const RejectOtSlipSchema = z.object({
  slip_id: z.string().uuid(),
  notes: z.string().trim().min(1, "Reason is required.").max(500),
});

export async function rejectOtSlipAction(
  slip_id: string,
  notes: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = RejectOtSlipSchema.safeParse({ slip_id, notes });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Fetch-then-decide so the error message can be specific (voided vs already
  // decided vs missing). Mirrors voidOtSlipAction.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_ot_slips")
    .select("id, status, employee_id, work_date")
    .eq("id", parsed.data.slip_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "OT slip not found." };
  }
  if (existing.status === "voided") {
    return { ok: false, error: "OT slip is voided. It can't be rejected." };
  }
  if (existing.status !== "pending") {
    return { ok: false, error: `OT slip is already ${existing.status}.` };
  }

  const { data: updated, error } = await admin
    .from("payroll_ot_slips")
    .update({
      status: "rejected",
      decided_at: new Date().toISOString(),
      decided_by: session.user_id,
      decision_notes: parsed.data.notes,
    })
    .eq("id", parsed.data.slip_id)
    .select("id, employee_id, work_date")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "OT slip not found." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_ot_slip.rejected",
    resource_type: "payroll_ot_slip",
    resource_id: updated.id,
    metadata: {
      employee_id: updated.employee_id,
      work_date: updated.work_date,
      notes: parsed.data.notes,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

const VoidOtSlipSchema = z.object({
  slip_id: z.string().uuid(),
});

export async function voidOtSlipAction(
  slip_id: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = VoidOtSlipSchema.safeParse({ slip_id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Void from any non-terminal state. The `decided_*` fields are populated so
  // we always know who voided it and when.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_ot_slips")
    .select("id, status, employee_id, work_date")
    .eq("id", parsed.data.slip_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "OT slip not found." };
  }
  if (existing.status === "voided") {
    return { ok: false, error: "OT slip is already voided." };
  }

  const { error } = await admin
    .from("payroll_ot_slips")
    .update({
      status: "voided",
      decided_at: new Date().toISOString(),
      decided_by: session.user_id,
    })
    .eq("id", parsed.data.slip_id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_ot_slip.voided",
    resource_type: "payroll_ot_slip",
    resource_id: existing.id,
    metadata: {
      employee_id: existing.employee_id,
      work_date: existing.work_date,
      prior_status: existing.status,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

// =============================================================================
// Holidays
// =============================================================================

export async function addHolidayAction(
  input: AddHolidayInput,
): Promise<ConfigActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddHolidaySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_holidays")
    .insert({
      date: parsed.data.date,
      kind: parsed.data.kind,
      name: parsed.data.name,
      notes: parsed.data.notes ?? null,
    })
    .select("id, date, kind, name")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not add holiday.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_holiday.added",
    resource_type: "payroll_holiday",
    resource_id: created.id,
    metadata: {
      date: created.date,
      kind: created.kind,
      name: created.name,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: { id: created.id } };
}

const RemoveHolidaySchema = z.object({
  id: z.string().uuid(),
});

export async function removeHolidayAction(
  id: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = RemoveHolidaySchema.safeParse({ id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Soft-disable via is_active = false. Avoids cascading effects on any past
  // payroll runs that already booked holiday pay for this date. The
  // `.eq("is_active", true)` filter makes this idempotent: re-running on an
  // already-removed holiday returns 0 affected rows and we skip the audit
  // write so we don't spam the log with no-op flips.
  const { data: updated, error } = await admin
    .from("payroll_holidays")
    .update({ is_active: false })
    .eq("id", parsed.data.id)
    .eq("is_active", true)
    .select("id, date, kind, name");
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated || updated.length === 0) {
    // Either the holiday doesn't exist, or it was already inactive. In both
    // cases this is a no-op; don't write an audit row.
    return { ok: true, data: undefined };
  }
  const row = updated[0]!;

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_holiday.removed",
    resource_type: "payroll_holiday",
    resource_id: row.id,
    metadata: {
      date: row.date,
      kind: row.kind,
      name: row.name,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

// =============================================================================
// Contribution brackets (SSS / PhilHealth / Pag-IBIG)
// =============================================================================

export async function createContributionBracketAction(
  input: CreateContributionBracketInput,
): Promise<ConfigActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateContributionBracketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_contribution_brackets")
    .insert({
      kind: parsed.data.kind,
      effective_from: parsed.data.effective_from,
      effective_to: parsed.data.effective_to ?? null,
      monthly_salary_credit_min_php: parsed.data.monthly_salary_credit_min_php,
      monthly_salary_credit_max_php: parsed.data.monthly_salary_credit_max_php,
      employee_share_php: parsed.data.employee_share_php,
      employer_share_php: parsed.data.employer_share_php,
      notes: parsed.data.notes ?? null,
    })
    .select("id, kind, effective_from")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create contribution bracket.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_bracket.contribution_created",
    resource_type: "payroll_contribution_bracket",
    resource_id: created.id,
    metadata: {
      kind: created.kind,
      effective_from: created.effective_from,
      msc_min: parsed.data.monthly_salary_credit_min_php,
      msc_max: parsed.data.monthly_salary_credit_max_php,
      employee_share_php: parsed.data.employee_share_php,
      employer_share_php: parsed.data.employer_share_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: { id: created.id } };
}

const EndContributionBracketSchema = z.object({
  id: z.string().uuid(),
  effective_to: z.string().min(1, "effective_to is required."),
});

export async function endContributionBracketAction(
  id: string,
  effective_to: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = EndContributionBracketSchema.safeParse({ id, effective_to });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("payroll_contribution_brackets")
    .update({ effective_to: parsed.data.effective_to })
    .eq("id", parsed.data.id)
    .select("id, kind, effective_from")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "Contribution bracket not found." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_bracket.contribution_ended",
    resource_type: "payroll_contribution_bracket",
    resource_id: updated.id,
    metadata: {
      kind: updated.kind,
      effective_from: updated.effective_from,
      effective_to: parsed.data.effective_to,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

// =============================================================================
// Withholding-tax brackets
// =============================================================================

export async function createWtBracketAction(
  input: CreateWtBracketInput,
): Promise<ConfigActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateWtBracketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_wt_brackets")
    .insert({
      effective_from: parsed.data.effective_from,
      effective_to: parsed.data.effective_to ?? null,
      taxable_min_php: parsed.data.taxable_min_php,
      taxable_max_php: parsed.data.taxable_max_php ?? null,
      base_tax_php: parsed.data.base_tax_php,
      marginal_rate: parsed.data.marginal_rate,
    })
    .select("id, effective_from")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create WT bracket.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_bracket.wt_created",
    resource_type: "payroll_wt_bracket",
    resource_id: created.id,
    metadata: {
      effective_from: created.effective_from,
      taxable_min_php: parsed.data.taxable_min_php,
      taxable_max_php: parsed.data.taxable_max_php ?? null,
      base_tax_php: parsed.data.base_tax_php,
      marginal_rate: parsed.data.marginal_rate,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: { id: created.id } };
}

const EndWtBracketSchema = z.object({
  id: z.string().uuid(),
  effective_to: z.string().min(1, "effective_to is required."),
});

export async function endWtBracketAction(
  id: string,
  effective_to: string,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = EndWtBracketSchema.safeParse({ id, effective_to });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("payroll_wt_brackets")
    .update({ effective_to: parsed.data.effective_to })
    .eq("id", parsed.data.id)
    .select("id, effective_from")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "WT bracket not found." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_bracket.wt_ended",
    resource_type: "payroll_wt_bracket",
    resource_id: updated.id,
    metadata: {
      effective_from: updated.effective_from,
      effective_to: parsed.data.effective_to,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}

// =============================================================================
// Payroll-related accounting_settings
// =============================================================================

export async function updatePayrollSettingAction(
  input: UpdatePayrollSettingInput,
): Promise<ConfigActionResult> {
  const session = await requireAdminStaff();
  const parsed = UpdatePayrollSettingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Upsert on `key` — the CHECK constraint guarantees only known payroll keys
  // are accepted, so any unknown key here will fail at the DB layer.
  const { data: upserted, error } = await admin
    .from("accounting_settings")
    .upsert(
      {
        key: parsed.data.key,
        value_php: parsed.data.value_php,
        updated_by: session.user_id,
      },
      { onConflict: "key" },
    )
    .select("id, key, value_php")
    .single();
  if (error || !upserted) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not update setting.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_setting.updated",
    resource_type: "accounting_setting",
    resource_id: upserted.id,
    metadata: {
      key: parsed.data.key,
      new_value: parsed.data.value_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(CONFIG_PATH);
  return { ok: true, data: undefined };
}
