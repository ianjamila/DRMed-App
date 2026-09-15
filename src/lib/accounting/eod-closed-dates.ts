import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { shiftISODate, todayManilaISODate } from "@/lib/dates/manila";

/** A year back is more than enough: `bill_payments_payment_date_not_future`
 *  caps the other end, and nobody back-dates a supplier payment further. */
const LOOKBACK_DAYS = 365;

export interface ClosedDayContext {
  /** `chart_of_accounts.id` for 1010 Cash on Hand, or null if it is missing. */
  tillAccountId: string | null;
  /** Manila ISO dates whose EOD close is already signed off for the active shift. */
  closedDates: string[];
}

/**
 * What the AP payment forms need to warn about a closed day *before* the form
 * is submitted.
 *
 * Since 0147 a bill payment against 1010 writes an `eod_cash_adjustments` row
 * in the same transaction, so `trg_eod_cash_adjustments_block_after_close_iu`
 * refuses the whole payment (P0015) when the payment date lands on a closed
 * day. The refusal is correct, but discovering it only at submit — after the
 * vendor, the allocations and the amount are all typed — is a bad way to find
 * out. Both forms surface it as soon as the date and the cash account are
 * chosen.
 *
 * The shift is resolved the same way every shift-less path resolves it (first
 * active by `sort_order, code`): `payments_block_after_close`,
 * `cash_drawer_state`'s callers, `postTillCashExpense`, and the 0147 link
 * trigger itself. Reading a different shift here would warn about the wrong
 * days.
 */
export async function loadClosedDayContext(): Promise<ClosedDayContext> {
  const admin = createAdminClient();

  const [tillR, shiftR] = await Promise.all([
    admin.from("chart_of_accounts").select("id").eq("code", "1010").maybeSingle(),
    admin
      .from("cash_shifts")
      .select("id")
      .eq("is_active", true)
      .order("sort_order")
      .order("code")
      .limit(1)
      .maybeSingle(),
  ]);

  const tillAccountId = tillR.data?.id ?? null;
  if (!shiftR.data) return { tillAccountId, closedDates: [] };

  const { data } = await admin
    .from("eod_close_records")
    .select("business_date")
    .eq("shift_id", shiftR.data.id)
    .eq("status", "closed")
    .gte("business_date", shiftISODate(todayManilaISODate(), -LOOKBACK_DAYS))
    .order("business_date", { ascending: false });

  return {
    tillAccountId,
    closedDates: (data ?? []).map((r) => r.business_date),
  };
}
