import "server-only";

import { translatePgError } from "./pg-errors";

/**
 * P0015, said the way an AP bookkeeper needs to hear it.
 *
 * Since 0147 an AP cash bill payment writes an `eod_cash_adjustments` row in
 * the same transaction, so `trg_eod_cash_adjustments_block_after_close_iu`
 * now applies to it: a cash payment dated into an already-closed
 * (business_date, shift) is refused and the whole payment rolls back.
 *
 * That is correct — a closed day has been counted and its variance posted, so
 * back-dating a payout into it would falsify a count someone already signed
 * off — but the generic P0015 string talks about "recording further activity"
 * on a page that has nothing to do with the cash drawer, and the bookkeeper is
 * left guessing which of the two dates on the form is the problem. Say the
 * specific thing instead, and name both ways out.
 *
 * Only the two AP payment write paths use this; every other caller of
 * `translatePgError` still gets the cash-drawer wording, which is right for
 * them.
 */
export function translateBillPaymentError(err: {
  code?: string;
  message?: string;
  details?: string;
}): string {
  if (err.code === "P0015") {
    return (
      "That day's cash count is already closed, so a cash payment can't be added to it. " +
      "Either date the payment to an open day, or ask an admin to reopen the end-of-day close first."
    );
  }
  return translatePgError(err);
}
