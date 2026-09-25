"use server";

import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { postExpenseJournalEntry } from "./post-expense";
import { postTillCashExpense } from "./post-till-cash-expense";
import {
  isTillCashMop,
  type ExpenseCategory,
  type Mop,
} from "@/lib/accounting/expense-mappings";
import { isSendOutCategory, sendOutLabRule } from "@/lib/accounting/partner-labs";
import { verifyPartnerLab } from "@/lib/accounting/partner-labs.server";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const QuickExpenseSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  category: z.string().min(1, "Pick a category") as z.ZodType<ExpenseCategory>,
  mop: z.string().min(1, "Pick a payment source") as z.ZodType<Mop>,
  amount_php: z.number().positive("Amount must be greater than 0"),
  vendor_label: z.string().max(200).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  // 0164: the partner lab a Send Out expense paid. Required-iff-Send-Out is
  // `sendOutLabRule`, applied below — not a schema-level rule.
  vendor_id: z.string().uuid().optional().nullable(),
});

export type QuickExpenseInput = z.infer<typeof QuickExpenseSchema>;

/**
 * Admin "Quick expense" — an already-paid expense, booked from one form for
 * every payment source.
 *
 * **"Clinic Cash" is not a journal entry.** Physical cash out of the till is
 * written as an `eod_cash_adjustments` row (`kind='petty_cash'`) by
 * `postTillCashExpense`, exactly as the reception Petty Cash tab does, so the
 * cash drawer sees the outflow and the day-close lock applies. Every other MOP
 * still posts a plain journal entry through `postExpenseJournalEntry`.
 *
 * Before this split, Quick expense on Clinic Cash credited 1010 without ever
 * touching `eod_cash_adjustments` — the drawer never learned the money left,
 * reception counted short, and the close booked the shortage to 6900 Cash
 * Short/Over on top of the expense that had already credited cash. Quick
 * expense is AP's only sidebar door, so it was the most-travelled of the two.
 */
export async function createQuickExpenseAction(
  raw: QuickExpenseInput,
): Promise<ActionResult<{ id: string; entry_number: string }>> {
  const profile = await requireAdminStaff();

  const parsed = QuickExpenseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  const isSendOut = isSendOutCategory(input.category);
  const labError = sendOutLabRule(isSendOut, input.vendor_id ?? null);
  if (labError) return { ok: false, error: labError };

  let labName: string | null = null;
  if (input.vendor_id) {
    const verifyError = await verifyPartnerLab(input.vendor_id);
    if (verifyError) return { ok: false, error: verifyError };

    const admin = createAdminClient();
    const { data: lab } = await admin
      .from("vendors")
      .select("name")
      .eq("id", input.vendor_id)
      .maybeSingle();
    labName = lab?.name ?? null;
  }

  // If the vendor/payee label was left blank, default it to the lab's name so
  // the journal description reads "Send Out — Hi Precision" rather than just
  // "Send Out".
  const vendorLabel = input.vendor_label?.trim() || labName;

  if (isTillCashMop(input.mop)) {
    const posted = await postTillCashExpense({
      business_date: input.expense_date,
      category: input.category,
      amount_php: input.amount_php,
      vendor_label: vendorLabel,
      description: input.description ?? null,
      actorId: profile.user_id,
      vendor_id: input.vendor_id ?? null,
    });
    if (!posted.ok) return posted;

    await audit({
      actor_id: profile.user_id,
      actor_type: "staff",
      action: "quick_expense.posted",
      resource_type: "eod_cash_adjustments",
      resource_id: posted.data.adjustment_id,
      metadata: {
        category: input.category,
        mop: input.mop,
        amount_php: Math.round(input.amount_php * 100) / 100,
        vendor_label: vendorLabel,
        vendor_id: input.vendor_id ?? null,
        business_date: posted.data.business_date,
        shift_id: posted.data.shift_id,
        journal_entry_id: posted.data.journal_entry_id,
        entry_number: posted.data.entry_number,
        routed_to_cash_drawer: true,
      },
    });

    revalidatePath("/staff/admin/accounting/ap");
    revalidatePath("/staff/admin/accounting/journal");
    revalidatePath("/staff/payments/petty-cash");
    revalidatePath("/staff/payments/cash-drawer");
    revalidatePath("/staff/payments/eod");

    return {
      ok: true,
      data: {
        id: posted.data.adjustment_id,
        entry_number: posted.data.entry_number ?? "",
      },
    };
  }

  const posted = await postExpenseJournalEntry({
    expense_date: input.expense_date,
    category: input.category,
    mop: input.mop,
    amount_php: input.amount_php,
    vendor_label: vendorLabel,
    description: input.description ?? null,
    actorId: profile.user_id,
    sourceKind: "manual",
    notesTag: "quick_expense",
    vendor_id: input.vendor_id ?? null,
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
      vendor_label: vendorLabel,
      vendor_id: input.vendor_id ?? null,
      routed_to_cash_drawer: false,
    },
  });

  revalidatePath("/staff/admin/accounting/ap");
  revalidatePath("/staff/admin/accounting/journal");

  return { ok: true, data: posted.data };
}
