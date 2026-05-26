"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const SetBudgetSchema = z.object({
  fiscal_year: z.number().int().min(2020).max(2099),
  account_id: z.string().uuid(),
  annual_amount_php: z.number().min(0).max(999_999_999),
  notes: z.string().max(1000).optional().nullable(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function setBudget(
  input: z.infer<typeof SetBudgetSchema>,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = SetBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const data = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("budgets")
    .upsert(
      {
        fiscal_year: data.fiscal_year,
        account_id: data.account_id,
        annual_amount_php: data.annual_amount_php,
        notes: data.notes ?? null,
        created_by: session.user_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "fiscal_year,account_id" },
    );
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "budget.set",
    resource_type: "budgets",
    resource_id: `${data.fiscal_year}:${data.account_id}`,
    metadata: { fiscal_year: data.fiscal_year, amount_php: data.annual_amount_php },
  });

  revalidatePath("/staff/admin/accounting/variance");
  return { ok: true };
}

export async function deleteBudget(
  fiscalYear: number,
  accountId: string,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();
  const { error } = await admin
    .from("budgets")
    .delete()
    .eq("fiscal_year", fiscalYear)
    .eq("account_id", accountId);
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "budget.deleted",
    resource_type: "budgets",
    resource_id: `${fiscalYear}:${accountId}`,
  });

  revalidatePath("/staff/admin/accounting/variance");
  return { ok: true };
}
