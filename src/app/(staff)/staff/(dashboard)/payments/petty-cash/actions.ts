"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import {
  postTillCashExpense,
  voidTillCashExpense,
} from "@/lib/actions/accounting/post-till-cash-expense";
import {
  PETTY_CASH_CATEGORIES,
  type ExpenseCategory,
} from "@/lib/accounting/expense-mappings";
import { todayManilaISODate } from "@/lib/dates/manila";

type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// Reception + admin only — mirrors the cash-drawer action gate.
function canManagePettyCash(role: string): boolean {
  return role === "reception" || role === "admin";
}

/**
 * Revalidate every surface a till expense now moves. Since the entry is an
 * `eod_cash_adjustments` row rather than a bare journal entry, it changes the
 * drawer's expected cash and the EOD close screen too — not just this page and
 * the journal.
 */
function revalidateTillSurfaces(): void {
  revalidatePath("/staff/payments/petty-cash");
  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/payments/eod");
  revalidatePath("/staff/admin/accounting/journal");
}

// Petty cash is, by definition, paid from the till — the payment source is
// always Clinic Cash (CR 1010). The category is restricted to the reception
// subset (see PETTY_CASH_CATEGORIES); owner/payroll accounts and the 9999
// suspense ("Out of Pocket Expense") are intentionally not offered.
const PettyCashSchema = z.object({
  expense_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    // The drawer's own writer refuses a future business_date
    // (RecordCashAdjustmentSchema), and a future-dated payout would inflate
    // today's expected cash against a day that hasn't happened. Same rule here
    // now that both doors write the same table.
    .refine(
      (d) => d <= todayManilaISODate(),
      "Date can't be in the future",
    ),
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

/**
 * Records a petty-cash expense as an `eod_cash_adjustments` row
 * (`kind='petty_cash'`), NOT as a direct journal entry.
 *
 * The DB bridge trigger posts the journal entry from that row, so the books
 * land exactly where they did before — but now `cash_drawer_state` also counts
 * the payout, and the day-close lock (P0015) applies. See
 * `postTillCashExpense` for why writing the JE directly was wrong.
 */
export async function createPettyCashExpenseAction(
  raw: PettyCashInput,
): Promise<
  ActionResult<{ id: string; entry_number: string; adjustment_id: string }>
> {
  const session = await requireActiveStaff();
  if (!canManagePettyCash(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = PettyCashSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const input = parsed.data;

  const posted = await postTillCashExpense({
    business_date: input.expense_date,
    category: input.category,
    amount_php: input.amount_php,
    vendor_label: input.vendor_label ?? null,
    description: input.description ?? null,
    actorId: session.user_id,
  });
  if (!posted.ok) return posted;

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "petty_cash.posted",
    resource_type: "eod_cash_adjustments",
    resource_id: posted.data.adjustment_id,
    metadata: {
      category: input.category,
      amount_php: Math.round(input.amount_php * 100) / 100,
      vendor_label: input.vendor_label?.trim() || null,
      business_date: posted.data.business_date,
      shift_id: posted.data.shift_id,
      journal_entry_id: posted.data.journal_entry_id,
      entry_number: posted.data.entry_number,
      via: "petty_cash_page",
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateTillSurfaces();
  return {
    ok: true,
    data: {
      id: posted.data.adjustment_id,
      adjustment_id: posted.data.adjustment_id,
      entry_number: posted.data.entry_number ?? "",
    },
  };
}

const VoidSchema = z.object({
  adjustment_id: z.string().uuid("Invalid entry"),
  void_reason: z.string().trim().min(3, "Give a short reason for the reversal"),
});

/**
 * Voids a petty-cash entry.
 *
 * Now an `eod_cash_adjustments` void: setting `voided_at` fires
 * `trg_bridge_cash_adjustment_void`, which posts the mirror reversal JE and
 * flips the original to 'reversed' — atomically, in one statement, and the
 * drawer's expected cash goes back up at the same time.
 *
 * This replaces the `reverse_petty_cash_entry` RPC (migration 0102, dropped in
 * 0145), which only knew how to reverse `source_kind='petty_cash'` journal
 * entries — a shape this page no longer produces.
 */
export async function voidPettyCashExpenseAction(
  adjustment_id: string,
  void_reason: string,
): Promise<ActionResult<{ reversal_id: string | null }>> {
  const session = await requireActiveStaff();
  if (!canManagePettyCash(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = VoidSchema.safeParse({ adjustment_id, void_reason });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const voided = await voidTillCashExpense({
    adjustment_id: parsed.data.adjustment_id,
    void_reason: parsed.data.void_reason,
    actorId: session.user_id,
  });
  if (!voided.ok) return voided;

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "petty_cash.voided",
    resource_type: "eod_cash_adjustments",
    resource_id: parsed.data.adjustment_id,
    metadata: {
      reversal_journal_entry_id: voided.data.reversal_id,
      void_reason: parsed.data.void_reason,
      via: "petty_cash_page",
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateTillSurfaces();
  return { ok: true, data: { reversal_id: voided.data.reversal_id } };
}
