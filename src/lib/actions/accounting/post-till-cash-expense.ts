import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CATEGORY_TO_COA,
  type ExpenseCategory,
} from "@/lib/accounting/expense-mappings";
import { todayManilaISODate } from "@/lib/dates/manila";

export type PostTillCashResult =
  | {
      ok: true;
      data: {
        /** `eod_cash_adjustments.id` — the row the whole flow now hangs off. */
        adjustment_id: string;
        shift_id: string;
        business_date: string;
        /** Posted by the bridge trigger, not by us. Null only if the read-back raced. */
        journal_entry_id: string | null;
        entry_number: string | null;
      };
    }
  | { ok: false; error: string };

/**
 * Records an expense paid in physical cash out of the reception till.
 *
 * This is the ONLY correct writer for a Clinic Cash expense, and it is
 * deliberately *not* a journal-entry writer. It inserts one
 * `eod_cash_adjustments` row (`kind='petty_cash'`) and lets the database do
 * the rest:
 *
 *   - `trg_bridge_cash_adjustment_insert` posts the balanced JE for free
 *     (DR <category account> / CR 1010), `source_kind='cash_adjustment'`.
 *   - `cash_drawer_state.expected_cash_php` counts the row as a payout, so the
 *     day's expected cash drops by the same peso the till actually lost.
 *   - `trg_eod_cash_adjustments_block_after_close_iu` applies the day-close
 *     lock (P0015), which a direct JE insert walked straight past.
 *   - Voiding is a plain `voided_at` update; `trg_bridge_cash_adjustment_void`
 *     posts the reversal JE.
 *
 * Writing the JE directly instead (the pre-fix behaviour of both the Petty cash
 * page and Quick expense on "Clinic Cash") moved the books but not the drawer:
 * reception counted short, the close booked the shortage to 6900 Cash
 * Short/Over, and that one outflow ended up crediting cash twice. See
 * `TILL_CASH_MOP` in expense-mappings.ts.
 *
 * The category becomes `contra_account_id`. We always resolve it explicitly
 * rather than letting the DB fall back: `cash_adjustment_account_map` marks
 * `petty_cash` as `requires_user_choice`, so a null contra would land the
 * expense in 9999 Suspense plus a `coa.suspense_post` audit row.
 *
 * Auth, audit and revalidation live in the calling Server Action, not here.
 */
export async function postTillCashExpense(args: {
  /** Manila ISO date (YYYY-MM-DD). Becomes `business_date` AND the JE posting date. */
  business_date: string;
  category: ExpenseCategory;
  amount_php: number;
  vendor_label: string | null;
  description: string | null;
  actorId: string;
  /** 0164: the partner lab a Send Out expense paid. Validate with
   *  `sendOutLabRule` + `verifyPartnerLab` before calling this. */
  vendor_id?: string | null;
  /**
   * Caller-picked shift (e.g. the shift the Cash Drawer / Petty Cash tab is
   * viewing). When given, it is verified against `cash_shifts` here — never
   * trusted from the caller — and the expense is booked to it. Omit to fall
   * back to the first active shift by sort order (today's default, and the
   * only shape that existed before multi-shift sites).
   */
  shift_id?: string;
}): Promise<PostTillCashResult> {
  const contraCode = CATEGORY_TO_COA[args.category];
  if (!contraCode) {
    return { ok: false, error: `Unknown category: ${args.category}` };
  }

  // Enforced here, in the shared writer, rather than only in each caller's
  // schema — Quick expense lets an admin pick any expense date, and a
  // future-dated payout would sit on a business day that hasn't happened yet
  // and silently drop out of every drawer view until it arrived. Matches the
  // drawer's own RecordCashAdjustmentSchema rule.
  if (args.business_date > todayManilaISODate()) {
    return { ok: false, error: "Date can't be in the future." };
  }

  const admin = createAdminClient();

  let shiftId: string;
  if (args.shift_id) {
    // Trust nothing the caller sends: re-verify the shift still exists and is
    // still active. It can go inactive between the page render that offered
    // it and the submit (admin turns a shift off mid-day), and a stale id
    // must not silently fall back to a different drawer.
    const { data: pickedShift, error: pickedShiftErr } = await admin
      .from("cash_shifts")
      .select("id, is_active")
      .eq("id", args.shift_id)
      .maybeSingle();
    if (pickedShiftErr) return { ok: false, error: translatePgError(pickedShiftErr) };
    if (!pickedShift || !pickedShift.is_active) {
      return {
        ok: false,
        error: "That cash shift is not active. Pick another shift.",
      };
    }
    shiftId = pickedShift.id;
  } else {
    // Same rule the DB itself uses when it needs a shift for a table that has
    // no shift column (`payments_block_after_close`): the first active shift
    // by sort order. The cash drawer page defaults the same way.
    const { data: shift, error: shiftErr } = await admin
      .from("cash_shifts")
      .select("id")
      .eq("is_active", true)
      .order("sort_order")
      .order("code")
      .limit(1)
      .maybeSingle();
    if (shiftErr) return { ok: false, error: translatePgError(shiftErr) };
    if (!shift) {
      return {
        ok: false,
        error: "No active cash shift is configured. Ask an admin to set one up.",
      };
    }
    shiftId = shift.id;
  }

  const { data: contra, error: coaErr } = await admin
    .from("chart_of_accounts")
    .select("id")
    .eq("code", contraCode)
    .maybeSingle();
  if (coaErr) return { ok: false, error: translatePgError(coaErr) };
  if (!contra) {
    return { ok: false, error: `Chart of accounts is missing ${contraCode}.` };
  }

  const amount = Math.round(args.amount_php * 100) / 100;
  const vendor = args.vendor_label?.trim() || null;

  // `payee` is the drawer's "who got the money" column and is capped at 120 in
  // RecordCashAdjustmentSchema; the expense forms allow 200, so trim to fit
  // rather than let the longer value through a different door.
  const { data: row, error } = await admin
    .from("eod_cash_adjustments")
    .insert({
      business_date: args.business_date,
      shift_id: shiftId,
      kind: "petty_cash",
      amount_php: amount,
      payee: vendor ? vendor.slice(0, 120) : null,
      contra_account_id: contra.id,
      vendor_id: args.vendor_id ?? null,
      notes: args.description?.trim()?.slice(0, 500) || null,
      recorded_by: args.actorId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: translatePgError(error) };

  // Read back the JE the insert trigger just posted, so the caller's audit row
  // can carry it — mirrors recordCashAdjustmentAction in the cash drawer.
  const { data: je } = await admin
    .from("journal_entries")
    .select("id, entry_number")
    .eq("source_kind", "cash_adjustment")
    .eq("source_id", row.id)
    .eq("status", "posted")
    .maybeSingle();

  return {
    ok: true,
    data: {
      adjustment_id: row.id,
      shift_id: shiftId,
      business_date: args.business_date,
      journal_entry_id: je?.id ?? null,
      entry_number: je?.entry_number ?? null,
    },
  };
}

/**
 * Voids a till-cash expense recorded by `postTillCashExpense`.
 *
 * Setting `voided_at` fires `trg_bridge_cash_adjustment_void`, which posts the
 * mirror reversal JE and flips the original to `status='reversed'` — so this is
 * the adjustment-table equivalent of the old `reverse_petty_cash_entry` RPC
 * (dropped in 0145), and the same mechanism the cash drawer's own Void uses.
 *
 * The `.is("voided_at", null)` filter makes a double-void a no-op rather than a
 * second reversal: the update matches no row, and we report that as an error
 * instead of letting the caller log a second audit row for nothing.
 */
export async function voidTillCashExpense(args: {
  adjustment_id: string;
  void_reason: string;
  actorId: string;
}): Promise<
  | { ok: true; data: { reversal_id: string | null } }
  | { ok: false; error: string }
> {
  const admin = createAdminClient();

  const { data: updated, error } = await admin
    .from("eod_cash_adjustments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: args.actorId,
      void_reason: args.void_reason,
    })
    .eq("id", args.adjustment_id)
    .eq("kind", "petty_cash")
    .is("voided_at", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };

  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: "That entry is already voided, or is not a petty cash entry.",
    };
  }

  const { data: originalJe } = await admin
    .from("journal_entries")
    .select("id")
    .eq("source_kind", "cash_adjustment")
    .eq("source_id", args.adjustment_id)
    .maybeSingle();

  const { data: rev } = originalJe
    ? await admin
        .from("journal_entries")
        .select("id")
        .eq("source_kind", "reversal")
        .eq("reverses", originalJe.id)
        .maybeSingle()
    : { data: null };

  return { ok: true, data: { reversal_id: rev?.id ?? null } };
}
