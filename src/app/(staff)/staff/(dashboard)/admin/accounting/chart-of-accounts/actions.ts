"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  AccountCreateSchema,
  AccountUpdateSchema,
} from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { deriveNormalBalance } from "@/lib/accounting/derive-normal-balance";

export type CoaResult = { ok: true } | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    code: formData.get("code"),
    name: formData.get("name"),
    type: formData.get("type"),
    parent_id: formData.get("parent_id") || null,
    description: formData.get("description") || null,
    is_active: formData.get("is_active"),
  };
}

export async function createAccountAction(
  _prev: CoaResult | null,
  formData: FormData,
): Promise<CoaResult> {
  const session = await requireAdminStaff();
  const raw = readForm(formData);
  const parsed = AccountCreateSchema.safeParse({
    code: raw.code,
    name: raw.name,
    type: raw.type,
    parent_id: raw.parent_id,
    description: raw.description,
    normal_balance: deriveNormalBalance(String(raw.type ?? "")),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("chart_of_accounts")
    .insert(parsed.data)
    .select("id, code, name, type, parent_id")
    .single();
  if (error || !created) {
    return { ok: false, error: translatePgError(error ?? { message: "Insert failed." }) };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "coa.account.created",
    resource_type: "chart_of_accounts",
    resource_id: created.id,
    metadata: {
      code: created.code,
      name: created.name,
      type: created.type,
      parent_id: created.parent_id,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/chart-of-accounts");
  redirect("/staff/admin/accounting/chart-of-accounts");
}

export async function updateAccountAction(
  accountId: string,
  _prev: CoaResult | null,
  formData: FormData,
): Promise<CoaResult> {
  const session = await requireAdminStaff();
  const raw = readForm(formData);
  const parsed = AccountUpdateSchema.safeParse({
    name: raw.name,
    type: raw.type,
    parent_id: raw.parent_id,
    description: raw.description,
    normal_balance: deriveNormalBalance(String(raw.type ?? "")),
    is_active: raw.is_active,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: before, error: fetchError } = await admin
    .from("chart_of_accounts")
    .select("name, type, parent_id, description, normal_balance, is_active")
    .eq("id", accountId)
    .maybeSingle();
  if (fetchError || !before) {
    return { ok: false, error: "Account not found." };
  }

  const { error } = await admin
    .from("chart_of_accounts")
    .update(parsed.data)
    .eq("id", accountId);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "coa.account.updated",
    resource_type: "chart_of_accounts",
    resource_id: accountId,
    metadata: { before, after: parsed.data },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/chart-of-accounts");
  redirect("/staff/admin/accounting/chart-of-accounts");
}

export async function toggleAccountActiveAction(
  accountId: string,
): Promise<CoaResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  // Read current state + check for blocking open-period postings.
  const { data: current } = await admin
    .from("chart_of_accounts")
    .select("code, is_active")
    .eq("id", accountId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Account not found." };

  // Strict deactivation guard: any posted JE line referencing this account
  // AND living in a period that is currently `open` blocks the toggle.
  // Lines in closed periods don't block — those are immutable history.
  // The check is delegated to the SQL helper coa_account_has_open_period_postings
  // (defined in migration 0028) to avoid a multi-hop join through Supabase JS.
  if (current.is_active) {
    const { data: hasOpen, error: rpcError } = await admin.rpc(
      "coa_account_has_open_period_postings",
      { p_account_id: accountId },
    );
    if (rpcError) {
      return { ok: false, error: translatePgError(rpcError) };
    }
    if (hasOpen === true) {
      return {
        ok: false,
        error:
          "Cannot deactivate: this account has posted journal lines in currently open periods. Move those lines to another account, or close the period first.",
      };
    }
  }

  const newActive = !current.is_active;
  const { error } = await admin
    .from("chart_of_accounts")
    .update({ is_active: newActive })
    .eq("id", accountId);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "coa.account.toggled",
    resource_type: "chart_of_accounts",
    resource_id: accountId,
    metadata: { code: current.code, is_active: newActive },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/chart-of-accounts");
  return { ok: true };
}
