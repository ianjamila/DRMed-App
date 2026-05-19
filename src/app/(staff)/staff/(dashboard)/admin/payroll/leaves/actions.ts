"use server";

// Server Actions for leave administration:
//   * Manual entitlements + grants (positive delta)
//   * Bulk apply_leave_entitlements(year) / apply_leave_expiry(year) via RPC
//   * Usage recording (negative delta — sign-flip from positive input)
//   * Cash conversion (negative delta)
//   * Forfeit on termination (negative delta per non-zero kind)
//
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §13.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import {
  AddLeaveGrantSchema,
  RecordLeaveUsageSchema,
  ApplyLeaveEntitlementsSchema,
  type AddLeaveGrantInput,
  type RecordLeaveUsageInput,
  type ApplyLeaveEntitlementsInput,
} from "@/lib/validations/accounting";

export type LeaveActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const LEAVES_PATH = "/staff/admin/payroll/leaves";

function todayManila(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

// =============================================================================
// addLeaveEntitlementAction — manual entitlement insert
// =============================================================================
//
// This is the manual counterpart to the bulk apply_leave_entitlements() RPC,
// used when an admin needs to insert a one-off entitlement row (e.g. a special
// allocation outside the standard SL/VL accrual). Inline schema; the shared
// `AddLeaveGrantSchema` is reserved for record_kind='manual_grant'.

const AddLeaveEntitlementSchema = z.object({
  employee_id: z.string().uuid(),
  kind: z.enum(["VL", "SL"]),
  days: z.coerce.number().positive().max(365),
  effective_date: z.string(),
  expiry_date: z.string().nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});
type AddLeaveEntitlementInput = z.infer<typeof AddLeaveEntitlementSchema>;

export async function addLeaveEntitlementAction(
  input: AddLeaveEntitlementInput,
): Promise<LeaveActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddLeaveEntitlementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("employee_leave_records")
    .insert({
      employee_id: parsed.data.employee_id,
      kind: parsed.data.kind,
      record_kind: "entitlement",
      days_delta: parsed.data.days, // positive
      effective_date: parsed.data.effective_date,
      expiry_date: parsed.data.expiry_date ?? null,
      reason: parsed.data.reason ?? null,
      created_by: session.user_id,
    })
    .select("id, employee_id, kind, days_delta")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not add entitlement.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.entitlement_added",
    resource_type: "employee_leave_record",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      kind: created.kind,
      days: created.days_delta,
      effective_date: parsed.data.effective_date,
      expiry_date: parsed.data.expiry_date ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { id: created.id } };
}

// =============================================================================
// addLeaveGrantAction — manual_grant
// =============================================================================

export async function addLeaveGrantAction(
  input: AddLeaveGrantInput,
): Promise<LeaveActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddLeaveGrantSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("employee_leave_records")
    .insert({
      employee_id: parsed.data.employee_id,
      kind: parsed.data.kind,
      record_kind: "manual_grant",
      days_delta: parsed.data.days, // positive
      effective_date: parsed.data.effective_date,
      expiry_date: parsed.data.expiry_date ?? null,
      reason: parsed.data.reason,
      created_by: session.user_id,
    })
    .select("id, employee_id, kind, days_delta")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not add leave grant.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.grant_added",
    resource_type: "employee_leave_record",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      kind: created.kind,
      days: created.days_delta,
      effective_date: parsed.data.effective_date,
      reason: parsed.data.reason,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { id: created.id } };
}

// =============================================================================
// applyLeaveEntitlementsForYearAction — bulk RPC
// =============================================================================

type ApplyEntitlementRow = {
  employee_id: string;
  kind: string;
  days_granted: number;
  notes: string;
};

export async function applyLeaveEntitlementsForYearAction(
  input: ApplyLeaveEntitlementsInput,
): Promise<LeaveActionResult<{ rows: ApplyEntitlementRow[] }>> {
  const session = await requireAdminStaff();
  const parsed = ApplyLeaveEntitlementsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_leave_entitlements", {
    p_year: parsed.data.year,
  });
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const rows = (data ?? []) as ApplyEntitlementRow[];

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.entitlement_added",
    resource_type: "employee_leave_record",
    resource_id: null,
    metadata: {
      year: parsed.data.year,
      rows_affected: rows.length,
      bulk: true,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { rows } };
}

// =============================================================================
// applyLeaveExpiryAction — bulk RPC
// =============================================================================

const ApplyLeaveExpirySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
});

type ApplyExpiryRow = {
  employee_id: string;
  kind: string;
  days_expired: number;
};

export async function applyLeaveExpiryAction(
  input: { year: number },
): Promise<LeaveActionResult<{ rows: ApplyExpiryRow[] }>> {
  const session = await requireAdminStaff();
  const parsed = ApplyLeaveExpirySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_leave_expiry", {
    p_year: parsed.data.year,
  });
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const rows = (data ?? []) as ApplyExpiryRow[];

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.expiry_applied",
    resource_type: "employee_leave_record",
    resource_id: null,
    metadata: {
      year: parsed.data.year,
      rows_affected: rows.length,
      bulk: true,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { rows } };
}

// =============================================================================
// recordLeaveUsageAction — sign-flips input.days from positive to negative
// =============================================================================

export async function recordLeaveUsageAction(
  input: RecordLeaveUsageInput,
): Promise<LeaveActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = RecordLeaveUsageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // CHECK constraint: usage rows must have days_delta <= 0. Input is positive,
  // so we negate it before insert. The no-overdraw trigger then runs and will
  // raise P0026 (translated client-side) if the balance can't cover it.
  const { data: created, error } = await admin
    .from("employee_leave_records")
    .insert({
      employee_id: parsed.data.employee_id,
      kind: parsed.data.kind,
      record_kind: "usage",
      days_delta: -parsed.data.days,
      effective_date: parsed.data.effective_date,
      period_id: parsed.data.period_id ?? null,
      reason: parsed.data.reason ?? null,
      created_by: session.user_id,
    })
    .select("id, employee_id, kind, days_delta")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not record leave usage.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.usage_recorded",
    resource_type: "employee_leave_record",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      kind: created.kind,
      days: parsed.data.days, // positive in metadata for readability
      effective_date: parsed.data.effective_date,
      period_id: parsed.data.period_id ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { id: created.id } };
}

// =============================================================================
// recordLeaveCashConversionAction — sign-flips input.days; record_kind='cash_conversion'
// =============================================================================

const CashConversionSchema = z.object({
  employee_id: z.string().uuid(),
  kind: z.enum(["VL", "SL"]),
  days: z.coerce.number().positive().max(365),
  effective_date: z.string(),
  reason: z.string().trim().max(500).nullable().optional(),
});
type CashConversionInput = z.infer<typeof CashConversionSchema>;

export async function recordLeaveCashConversionAction(
  input: CashConversionInput,
): Promise<LeaveActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CashConversionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Same sign-flip semantics as usage: cash_conversion delta is <= 0.
  const { data: created, error } = await admin
    .from("employee_leave_records")
    .insert({
      employee_id: parsed.data.employee_id,
      kind: parsed.data.kind,
      record_kind: "cash_conversion",
      days_delta: -parsed.data.days,
      effective_date: parsed.data.effective_date,
      reason: parsed.data.reason ?? null,
      created_by: session.user_id,
    })
    .select("id, employee_id, kind, days_delta")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not record cash conversion.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_leave.cash_conversion_recorded",
    resource_type: "employee_leave_record",
    resource_id: created.id,
    metadata: {
      employee_id: created.employee_id,
      kind: created.kind,
      days: parsed.data.days,
      effective_date: parsed.data.effective_date,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { id: created.id } };
}

// =============================================================================
// forfeitLeaveOnTerminationAction — VL + SL forfeit on employment termination
// =============================================================================

type ForfeitRow = { kind: "VL" | "SL"; balance: number; record_id: string };

export async function forfeitLeaveOnTerminationAction(
  employee_id: string,
): Promise<LeaveActionResult<{ forfeited: ForfeitRow[] }>> {
  const session = await requireAdminStaff();
  const parsed = z
    .object({ employee_id: z.string().uuid() })
    .safeParse({ employee_id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const today = todayManila();
  const forfeited: ForfeitRow[] = [];
  const { ip, ua } = await ipAndAgent();

  for (const kind of ["VL", "SL"] as const) {
    // Fetch current balance for this kind via the SQL helper.
    const { data: balanceRaw, error: balErr } = await admin.rpc(
      "employee_leave_balance",
      {
        p_employee_id: parsed.data.employee_id,
        p_kind: kind,
        p_as_of_date: today,
      },
    );
    if (balErr) {
      return { ok: false, error: translatePgError(balErr) };
    }
    const balance = Number(balanceRaw ?? 0);
    if (!Number.isFinite(balance) || balance <= 0) {
      // Nothing to forfeit for this kind; no audit row written.
      continue;
    }

    const { data: created, error: insertErr } = await admin
      .from("employee_leave_records")
      .insert({
        employee_id: parsed.data.employee_id,
        kind,
        record_kind: "expiry",
        days_delta: -balance,
        effective_date: today,
        reason: "termination",
        created_by: session.user_id,
      })
      .select("id")
      .single();
    if (insertErr || !created) {
      return {
        ok: false,
        error: insertErr
          ? translatePgError(insertErr)
          : `Could not forfeit ${kind} balance.`,
      };
    }
    forfeited.push({ kind, balance, record_id: created.id });

    // Audit-in-loop: one row per kind keyed to the inserted leave record. If
    // a later kind's insert fails, earlier audit rows are still durable.
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payroll_leave.forfeit_on_termination",
      resource_type: "employee_leave_record",
      resource_id: created.id,
      metadata: {
        employee_id: parsed.data.employee_id,
        kind,
        days_forfeited: balance,
        reason: "termination",
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidatePath(LEAVES_PATH);
  return { ok: true, data: { forfeited } };
}
