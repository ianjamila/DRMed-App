"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { todayManilaISODate } from "@/lib/dates/manila";
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
 * Voids a posted petty-cash entry by posting a balanced reversal JE (the same
 * pattern as `bridge_cash_adjustment_void`): swap the original lines'
 * debit/credit, post the reversal, then mark the original `reversed`. Only
 * source_kind='petty_cash' entries that are still 'posted' can be reversed.
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

  const { data: original, error: oErr } = await admin
    .from("journal_entries")
    .select("id, entry_number, status, source_kind")
    .eq("id", parsed.data.je_id)
    .maybeSingle();
  if (oErr) return { ok: false, error: translatePgError(oErr) };
  if (!original || original.source_kind !== "petty_cash") {
    return { ok: false, error: "Petty-cash entry not found." };
  }
  if (original.status !== "posted") {
    return { ok: false, error: "This entry is already reversed." };
  }

  const { data: lines, error: lErr } = await admin
    .from("journal_lines")
    .select("account_id, debit_php, credit_php, description, line_order")
    .eq("entry_id", original.id)
    .order("line_order", { ascending: true });
  if (lErr) return { ok: false, error: translatePgError(lErr) };
  if (!lines || lines.length === 0) {
    return { ok: false, error: "Entry has no lines to reverse." };
  }

  const today = todayManilaISODate();
  const { data: nextNum, error: nErr } = await admin.rpc("je_next_number", {
    p_fiscal_year: Number(today.slice(0, 4)),
  });
  if (nErr || !nextNum) {
    return {
      ok: false,
      error: translatePgError(nErr ?? { message: "je_next_number failed" }),
    };
  }

  const { data: rev, error: rErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: nextNum as string,
      posting_date: today,
      description:
        `Reversal of ${original.entry_number}: ${parsed.data.void_reason}`.slice(
          0,
          500,
        ),
      notes: `petty_cash_void | actor=${session.user_id}`,
      status: "draft",
      source_kind: "reversal",
      source_id: null,
      reverses: original.id,
      created_by: session.user_id,
    })
    .select("id")
    .single();
  if (rErr || !rev) {
    return {
      ok: false,
      error: translatePgError(rErr ?? { message: "Reversal insert failed" }),
    };
  }

  const { error: rlErr } = await admin.from("journal_lines").insert(
    lines.map((l) => ({
      entry_id: rev.id,
      account_id: l.account_id,
      debit_php: l.credit_php,
      credit_php: l.debit_php,
      description: l.description,
      line_order: l.line_order,
    })),
  );
  if (rlErr) {
    await admin.from("journal_entries").delete().eq("id", rev.id);
    return { ok: false, error: translatePgError(rlErr) };
  }

  const { error: postErr } = await admin
    .from("journal_entries")
    .update({ status: "posted", posted_at: new Date().toISOString() })
    .eq("id", rev.id);
  if (postErr) return { ok: false, error: translatePgError(postErr) };

  const { error: markErr } = await admin
    .from("journal_entries")
    .update({ status: "reversed", reversed_by: rev.id })
    .eq("id", original.id);
  if (markErr) return { ok: false, error: translatePgError(markErr) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "petty_cash.voided",
    resource_type: "journal_entry",
    resource_id: original.id,
    metadata: {
      entry_number: original.entry_number,
      reversal_id: rev.id,
      void_reason: parsed.data.void_reason,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/payments/petty-cash");
  revalidatePath("/staff/admin/accounting/journal");
  return { ok: true, data: { reversal_id: rev.id } };
}
