import "server-only";

import { translatePgError } from "./pg-errors";

/**
 * P0015, said the way an AP bookkeeper needs to hear it.
 *
 * Since 0149 an AP cash bill payment writes an `eod_cash_adjustments` row in
 * the same transaction, so `trg_eod_cash_adjustments_block_after_close_iu`
 * now applies to it. That lock is on INSERT **and** UPDATE, so it catches both
 * AP writes, not just the obvious one:
 *
 *   - CREATE — a cash payment dated into an already-closed (business_date,
 *     shift) is refused and the whole payment rolls back.
 *   - VOID — the void mirror updates that same drawer row, so voiding a cash
 *     payment whose day has since been closed is refused too, and the whole
 *     `ap_void_bill_payment_cascade` transaction (reversal JE included) rolls
 *     back. This is the COMMON case, not an edge one: a void almost always
 *     happens after the payment's own business day has been counted.
 *
 * Both refusals are correct — a closed day has been counted and its variance
 * posted, so changing what left the till on it would falsify a count someone
 * already signed off, and the petty-cash sibling (`voidTillCashExpense`) has
 * behaved this way since 0043. But the generic P0015 wording
 * ("nothing more can be recorded on that day") is written for the cash drawer,
 * and it reads as nonsense on a void. Say the specific thing, and name
 * the way out.
 *
 * Only the AP payment write paths use this; every other caller of
 * `translatePgError` gets the reception wording (`eodClosedMessage`), which
 * is right for them.
 */
export function translateBillPaymentError(
  err: { code?: string; message?: string; details?: string },
  action: "create" | "void" = "create",
): string {
  if (err.code === "P0015") {
    return action === "void"
      ? "This payment came out of the till on a day whose cash count is already closed, " +
          "so it can't be voided yet — undoing it would change a count that has been " +
          "signed off. Ask an admin to reopen the end-of-day close for that date first."
      : "That day's cash count is already closed, so a cash payment can't be added to it. " +
          "Either date the payment to an open day, or ask an admin to reopen the " +
          "end-of-day close first.";
  }
  return translatePgError(err);
}
