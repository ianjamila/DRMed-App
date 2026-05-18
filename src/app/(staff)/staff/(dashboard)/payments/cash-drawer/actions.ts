"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  RecordCashAdjustmentSchema,
  VoidCashAdjustmentSchema,
  CloseEodSchema,
  type RecordCashAdjustmentInput,
} from "@/lib/validations/accounting";
import type { Database } from "@/types/database";

type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

function reception(role: string): boolean {
  return role === "reception" || role === "admin";
}

export async function getCashDrawerStateAction(
  business_date: string,
  shift_id: string,
): Promise<ActionResult<{
  state: Record<string, unknown>;
  rows: Database["public"]["Tables"]["eod_cash_adjustments"]["Row"][];
}>> {
  const session = await requireActiveStaff();
  if (!reception(session.role)) return { ok: false, error: "Forbidden." };

  const admin = createAdminClient();
  const { data: state, error: stateErr } = await admin.rpc("cash_drawer_state", {
    p_business_date: business_date,
    p_shift_id: shift_id,
  });
  if (stateErr) return { ok: false, error: translatePgError(stateErr) };

  const { data: rows, error: rowsErr } = await admin
    .from("eod_cash_adjustments")
    .select("*")
    .eq("business_date", business_date)
    .eq("shift_id", shift_id)
    .order("recorded_at", { ascending: false });
  if (rowsErr) return { ok: false, error: translatePgError(rowsErr) };

  return { ok: true, data: { state: state as Record<string, unknown>, rows: rows ?? [] } };
}

export async function recordCashAdjustmentAction(
  input: RecordCashAdjustmentInput,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireActiveStaff();
  if (!reception(session.role)) return { ok: false, error: "Forbidden." };

  const parsed = RecordCashAdjustmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("eod_cash_adjustments")
    .insert({
      business_date: parsed.data.business_date,
      shift_id: parsed.data.shift_id,
      kind: parsed.data.kind,
      amount_php: parsed.data.amount_php,
      payee: parsed.data.payee ?? null,
      payee_staff_id: parsed.data.payee_staff_id ?? null,
      contra_account_id: parsed.data.contra_account_id ?? null,
      notes: parsed.data.notes ?? null,
      recorded_by: session.user_id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: translatePgError(error) };

  // Fetch the matching JE for the audit metadata.
  const { data: je } = await admin
    .from("journal_entries")
    .select("id, entry_number")
    .eq("source_kind", "cash_adjustment")
    .eq("source_id", data.id)
    .eq("status", "posted")
    .maybeSingle();

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_adjustment.created",
    resource_type: "eod_cash_adjustments",
    resource_id: data.id,
    metadata: {
      kind: parsed.data.kind,
      amount_php: parsed.data.amount_php,
      business_date: parsed.data.business_date,
      shift_id: parsed.data.shift_id,
      contra_account_id: parsed.data.contra_account_id ?? null,
      payee_staff_id: parsed.data.payee_staff_id ?? null,
      journal_entry_id: je?.id ?? null,
      journal_entry_number: je?.entry_number ?? null,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/payments/eod");
  return { ok: true, data: { id: data.id } };
}

export async function voidCashAdjustmentAction(
  id: string,
  void_reason: string,
): Promise<ActionResult> {
  const session = await requireActiveStaff();
  if (!reception(session.role)) return { ok: false, error: "Forbidden." };

  const parsed = VoidCashAdjustmentSchema.safeParse({ id, void_reason });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("eod_cash_adjustments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.void_reason,
    })
    .eq("id", parsed.data.id)
    .is("voided_at", null);
  if (error) return { ok: false, error: translatePgError(error) };

  const { data: rev } = await admin
    .from("journal_entries")
    .select("id, entry_number")
    .is("reverses", null)
    .eq("source_kind", "reversal");

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_adjustment.voided",
    resource_type: "eod_cash_adjustments",
    resource_id: parsed.data.id,
    metadata: { void_reason: parsed.data.void_reason },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });
  void rev;

  revalidatePath("/staff/payments/cash-drawer");
  return { ok: true, data: undefined };
}

export async function closeEodAction(
  business_date: string,
  shift_id: string,
  counted_cash_php: number,
  variance_reason: string | null,
): Promise<ActionResult<{ close_id: string; variance_php: number }>> {
  const session = await requireActiveStaff();
  if (!reception(session.role)) return { ok: false, error: "Forbidden." };

  const parsed = CloseEodSchema.safeParse({
    business_date, shift_id, counted_cash_php, variance_reason,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  const { data: state, error: stateErr } = await admin.rpc("cash_drawer_state", {
    p_business_date: parsed.data.business_date,
    p_shift_id: parsed.data.shift_id,
  });
  if (stateErr) return { ok: false, error: translatePgError(stateErr) };

  const s = state as {
    opening_float_php: number;
    cash_payments_php: number;
    cash_payouts_php: number;
    expected_cash_php: number;
  };
  const variance = Number(parsed.data.counted_cash_php) - Number(s.expected_cash_php);
  if (variance !== 0 && !parsed.data.variance_reason) {
    return { ok: false, error: "A reason is required when variance is not zero." };
  }

  const { data, error } = await admin
    .from("eod_close_records")
    .insert({
      business_date: parsed.data.business_date,
      shift_id: parsed.data.shift_id,
      status: "closed",
      opening_float_php: s.opening_float_php,
      cash_payments_php: s.cash_payments_php,
      cash_payouts_php: s.cash_payouts_php,
      expected_cash_php: s.expected_cash_php,
      counted_cash_php: parsed.data.counted_cash_php,
      variance_php: variance,
      variance_reason: variance === 0 ? null : parsed.data.variance_reason,
      closed_by: session.user_id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: translatePgError(error) };

  const { data: je } = await admin
    .from("journal_entries")
    .select("id, entry_number")
    .eq("source_kind", "eod_close")
    .eq("source_id", data.id)
    .eq("status", "posted")
    .maybeSingle();

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "eod_close.created",
    resource_type: "eod_close_records",
    resource_id: data.id,
    metadata: {
      business_date: parsed.data.business_date,
      shift_id: parsed.data.shift_id,
      expected_php: s.expected_cash_php,
      counted_php: parsed.data.counted_cash_php,
      variance_php: variance,
      variance_je_id: je?.id ?? null,
      has_reason: !!parsed.data.variance_reason,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/payments/eod");
  return { ok: true, data: { close_id: data.id, variance_php: variance } };
}
