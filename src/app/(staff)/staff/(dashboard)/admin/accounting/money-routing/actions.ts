"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  UpdateCashAdjustmentRoutingSchema,
  UpdateDefaultChangeFundSchema,
  UpdatePaymentMethodMapSchema,
} from "@/lib/validations/accounting";
import {
  isAllowedAccount,
  isFixedCashKind,
  isFixedPaymentMethod,
  type RoutingAccount,
} from "@/lib/accounting/money-routing";

type ActionResult = { ok: true } | { ok: false; error: string };

const PAGE = "/staff/admin/accounting/money-routing";
const FIXED_ERROR = "This one is fixed by the system and can't be changed.";
const WRONG_ACCOUNT_ERROR = "That account doesn't fit this row. Pick one from the list.";

async function loadAccount(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<RoutingAccount | null> {
  const { data } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();
  return data;
}

export async function updatePaymentRoutingAction(
  mapId: string,
  accountId: string,
  notes: string | null,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const parsed = UpdatePaymentMethodMapSchema.safeParse({ account_id: accountId, notes });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("payment_method_account_map")
    .select("payment_method, account_id, notes")
    .eq("id", mapId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Mapping not found." };
  if (isFixedPaymentMethod(before.payment_method)) return { ok: false, error: FIXED_ERROR };

  const account = await loadAccount(admin, parsed.data.account_id);
  if (!account || !isAllowedAccount({ side: "payment", key: before.payment_method }, account, before.account_id)) {
    return { ok: false, error: WRONG_ACCOUNT_ERROR };
  }

  const { error } = await admin
    .from("payment_method_account_map")
    .update({ account_id: parsed.data.account_id, notes: parsed.data.notes ?? null })
    .eq("id", mapId);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment_method_map.updated",
    resource_type: "payment_method_account_map",
    resource_id: mapId,
    metadata: { before, after: parsed.data },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(PAGE);
  return { ok: true };
}

export async function updateCashRoutingAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const parsed = UpdateCashAdjustmentRoutingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  if (isFixedCashKind(parsed.data.kind)) return { ok: false, error: FIXED_ERROR };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("cash_adjustment_account_map")
    .select("id, kind, account_id, requires_user_choice, notes")
    .eq("kind", parsed.data.kind)
    .maybeSingle();
  if (!before) return { ok: false, error: "Mapping not found." };

  const account = await loadAccount(admin, parsed.data.account_id);
  if (!account || !isAllowedAccount({ side: "cash", key: before.kind }, account, before.account_id)) {
    return { ok: false, error: WRONG_ACCOUNT_ERROR };
  }

  const { error } = await admin
    .from("cash_adjustment_account_map")
    .update({
      account_id: parsed.data.account_id,
      requires_user_choice: parsed.data.requires_user_choice,
      notes: parsed.data.notes ?? null,
    })
    .eq("kind", parsed.data.kind);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "cash_routing.updated",
    resource_type: "cash_adjustment_account_map",
    resource_id: before.id,
    metadata: { kind: parsed.data.kind, before, after: parsed.data },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(PAGE);
  // The Cash Drawer's picker reads these rows.
  revalidatePath("/staff/payments/cash-drawer");
  return { ok: true };
}

export async function updateDefaultChangeFundAction(amount_php: number): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const parsed = UpdateDefaultChangeFundSchema.safeParse({ amount_php });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid amount." };

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("accounting_settings")
    .select("value_php")
    .eq("key", "default_change_fund_php")
    .maybeSingle();

  const { error } = await admin
    .from("accounting_settings")
    .update({ value_php: parsed.data.amount_php, updated_by: session.user_id })
    .eq("key", "default_change_fund_php");
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
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
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(PAGE);
  // Starting cash on the Cash Drawer and End of Day comes from this figure.
  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/payments/eod");
  return { ok: true };
}
