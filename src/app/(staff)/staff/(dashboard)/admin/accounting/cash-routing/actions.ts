"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  ReopenEodSchema,
  UpdateCashAdjustmentRoutingSchema,
  UpdateDefaultChangeFundSchema,
  CashShiftCreateSchema,
  CashShiftUpdateSchema,
} from "@/lib/validations/accounting";

type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export async function reopenEodCloseAction(
  close_id: string,
  reopen_reason: string,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const parsed = ReopenEodSchema.safeParse({ close_id, reopen_reason });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid." };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("eod_close_records")
    .select("id, business_date, shift_id, status")
    .eq("id", parsed.data.close_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Close record not found." };
  if (before.status !== "closed") return { ok: false, error: "Close is already reopened." };

  const { error } = await admin
    .from("eod_close_records")
    .update({
      status: "reopened",
      reopened_at: new Date().toISOString(),
      reopened_by: session.user_id,
      reopen_reason: parsed.data.reopen_reason,
    })
    .eq("id", parsed.data.close_id);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "eod_close.reopened",
    resource_type: "eod_close_records",
    resource_id: parsed.data.close_id,
    metadata: {
      business_date: before.business_date,
      shift_id: before.shift_id,
      reopen_reason: parsed.data.reopen_reason,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/payments/eod");
  return { ok: true, data: undefined };
}

export async function updateCashAdjustmentRoutingAction(
  input: unknown,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = UpdateCashAdjustmentRoutingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid." };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("cash_adjustment_account_map")
    .select("kind, account_id, requires_user_choice, notes")
    .eq("kind", parsed.data.kind)
    .maybeSingle();
  if (!before) return { ok: false, error: "Mapping not found." };

  const { error } = await admin
    .from("cash_adjustment_account_map")
    .update({
      account_id: parsed.data.account_id,
      requires_user_choice: parsed.data.requires_user_choice,
      notes: parsed.data.notes ?? null,
    })
    .eq("kind", parsed.data.kind);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_routing.updated",
    resource_type: "cash_adjustment_account_map",
    resource_id: null,
    metadata: { kind: parsed.data.kind, before, after: parsed.data },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/cash-routing");
  return { ok: true, data: undefined };
}

export async function updateDefaultChangeFundAction(
  amount_php: number,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = UpdateDefaultChangeFundSchema.safeParse({ amount_php });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid." };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("accounting_settings")
    .select("value_php")
    .eq("key", "default_change_fund_php")
    .maybeSingle();

  const { error } = await admin
    .from("accounting_settings")
    .update({
      value_php: parsed.data.amount_php,
      updated_by: session.user_id,
    })
    .eq("key", "default_change_fund_php");
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "accounting_settings.updated",
    resource_type: "accounting_settings",
    resource_id: null,
    metadata: {
      key: "default_change_fund_php",
      before: before?.value_php ?? null,
      after: parsed.data.amount_php,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/cash-routing");
  return { ok: true, data: undefined };
}

export async function createCashShiftAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CashShiftCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid." };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cash_shifts")
    .insert({
      code: parsed.data.code,
      label: parsed.data.label,
      sort_order: parsed.data.sort_order,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_shift.created",
    resource_type: "cash_shifts",
    resource_id: data.id,
    metadata: parsed.data,
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });
  revalidatePath("/staff/admin/accounting/cash-routing");
  return { ok: true, data: { id: data.id } };
}

export async function updateCashShiftAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = CashShiftUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid." };

  const admin = createAdminClient();
  const patch: { label?: string; is_active?: boolean; sort_order?: number } = {};
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active;
  if (parsed.data.sort_order !== undefined) patch.sort_order = parsed.data.sort_order;
  const { error } = await admin
    .from("cash_shifts")
    .update(patch)
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_shift.updated",
    resource_type: "cash_shifts",
    resource_id: parsed.data.id,
    metadata: parsed.data,
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });
  revalidatePath("/staff/admin/accounting/cash-routing");
  return { ok: true, data: undefined };
}
