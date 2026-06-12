"use server";

import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { revalidatePath } from "next/cache";
import { postExpenseJournalEntry } from "./post-expense";
import {
  type ExpenseCategory,
  type Mop,
} from "@/lib/accounting/expense-mappings";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const QuickExpenseSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  category: z.string().min(1, "Pick a category") as z.ZodType<ExpenseCategory>,
  mop: z.string().min(1, "Pick a payment source") as z.ZodType<Mop>,
  amount_php: z.number().positive("Amount must be greater than 0"),
  vendor_label: z.string().max(200).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});

export type QuickExpenseInput = z.infer<typeof QuickExpenseSchema>;

export async function createQuickExpenseAction(
  raw: QuickExpenseInput,
): Promise<ActionResult<{ id: string; entry_number: string }>> {
  const profile = await requireAdminStaff();

  const parsed = QuickExpenseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  const posted = await postExpenseJournalEntry({
    expense_date: input.expense_date,
    category: input.category,
    mop: input.mop,
    amount_php: input.amount_php,
    vendor_label: input.vendor_label ?? null,
    description: input.description ?? null,
    actorId: profile.user_id,
    sourceKind: "manual",
    notesTag: "quick_expense",
  });
  if (!posted.ok) return posted;

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "quick_expense.posted",
    resource_type: "journal_entry",
    resource_id: posted.data.id,
    metadata: {
      category: input.category,
      mop: input.mop,
      amount_php: Math.round(input.amount_php * 100) / 100,
      vendor_label: input.vendor_label?.trim() || null,
    },
  });

  revalidatePath("/staff/admin/accounting/ap");
  revalidatePath("/staff/admin/accounting/journal");

  return { ok: true, data: posted.data };
}
