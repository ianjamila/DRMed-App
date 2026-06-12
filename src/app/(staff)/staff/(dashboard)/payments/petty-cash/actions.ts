"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { postExpenseJournalEntry } from "@/lib/actions/accounting/post-expense";
import {
  PETTY_CASH_CATEGORIES,
  type ExpenseCategory,
} from "@/lib/accounting/expense-mappings";

type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// Reception + admin only — mirrors the cash-drawer action gate.
function canManagePettyCash(role: string): boolean {
  return role === "reception" || role === "admin";
}

// Petty cash is, by definition, paid from the till — the payment source is
// always Clinic Cash (CR 1010). The category is restricted to the reception
// subset (see PETTY_CASH_CATEGORIES); owner/payroll accounts and the 9999
// suspense ("Out of Pocket Expense") are intentionally not offered.
const PettyCashSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  category: z
    .string()
    .refine(
      (c): c is ExpenseCategory =>
        (PETTY_CASH_CATEGORIES as string[]).includes(c),
      "Pick a category",
    ),
  amount_php: z.number().positive("Amount must be greater than 0"),
  vendor_label: z.string().max(200).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});

export type PettyCashInput = z.infer<typeof PettyCashSchema>;

export async function createPettyCashExpenseAction(
  raw: PettyCashInput,
): Promise<ActionResult<{ id: string; entry_number: string }>> {
  const session = await requireActiveStaff();
  if (!canManagePettyCash(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = PettyCashSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const input = parsed.data;

  const posted = await postExpenseJournalEntry({
    expense_date: input.expense_date,
    category: input.category,
    mop: "CLINIC CASH",
    amount_php: input.amount_php,
    vendor_label: input.vendor_label ?? null,
    description: input.description ?? null,
    actorId: session.user_id,
    sourceKind: "petty_cash",
    notesTag: "petty_cash",
  });
  if (!posted.ok) return posted;

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "petty_cash.posted",
    resource_type: "journal_entry",
    resource_id: posted.data.id,
    metadata: {
      category: input.category,
      amount_php: Math.round(input.amount_php * 100) / 100,
      vendor_label: input.vendor_label?.trim() || null,
      entry_number: posted.data.entry_number,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/payments/petty-cash");
  revalidatePath("/staff/admin/accounting/journal");
  return { ok: true, data: posted.data };
}

const VoidSchema = z.object({
  je_id: z.string().uuid("Invalid entry"),
  void_reason: z.string().trim().min(3, "Give a short reason for the reversal"),
});

/**
 * Voids a posted petty-cash entry. The actual reversal — post a balanced mirror
 * JE (lines swapped, source_kind='reversal', reverses=<original>) and mark the
 * original 'reversed' — runs atomically inside the `reverse_petty_cash_entry`
 * Postgres function (migration 0102), which locks the original row `for update`
 * so concurrent voids serialise and a half-done reversal can never double-count
 * the expense. Only source_kind='petty_cash' entries still 'posted' can be
 * reversed; the function raises (P0037/P0038) otherwise.
 */
export async function voidPettyCashExpenseAction(
  je_id: string,
  void_reason: string,
): Promise<ActionResult<{ reversal_id: string }>> {
  const session = await requireActiveStaff();
  if (!canManagePettyCash(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = VoidSchema.safeParse({ je_id, void_reason });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // entry_number for the audit log (best-effort; the reversal is the real check).
  const { data: original } = await admin
    .from("journal_entries")
    .select("entry_number")
    .eq("id", parsed.data.je_id)
    .maybeSingle();

  const { data: reversalId, error } = await admin.rpc(
    "reverse_petty_cash_entry",
    {
      p_je_id: parsed.data.je_id,
      p_reason: parsed.data.void_reason,
      p_actor: session.user_id,
    },
  );
  if (error || !reversalId) {
    return {
      ok: false,
      error: translatePgError(error ?? { message: "Reversal failed" }),
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "petty_cash.voided",
    resource_type: "journal_entry",
    resource_id: parsed.data.je_id,
    metadata: {
      entry_number: original?.entry_number ?? null,
      reversal_id: reversalId,
      void_reason: parsed.data.void_reason,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/payments/petty-cash");
  revalidatePath("/staff/admin/accounting/journal");
  return { ok: true, data: { reversal_id: reversalId as string } };
}
