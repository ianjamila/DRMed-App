/**
 * "Will this AP payment be refused because the day is already closed?"
 *
 * Since 0149 a bill payment whose cash account is 1010 Cash on Hand writes an
 * `eod_cash_adjustments` row in the same transaction, which puts it under the
 * day-close lock (P0015) for the first time. The database is the authority —
 * this is only the pre-flight the two AP payment forms use so the bookkeeper
 * finds out while the date field is still under their cursor, rather than
 * after filling in vendor, amount and allocations.
 *
 * Deliberately conservative in both directions:
 *   - it returns false when `tillAccountId` is null (1010 missing from the
 *     chart of accounts — the trigger wouldn't fire either), and
 *   - it keys on the ACCOUNT, not the method, exactly like the trigger: the
 *     till is account 1010 whatever the row calls its method.
 */
export function tillPaymentBlockedByClose(args: {
  cashAccountId: string | null | undefined;
  tillAccountId: string | null | undefined;
  paymentDate: string | null | undefined;
  closedDates: readonly string[];
}): boolean {
  const { cashAccountId, tillAccountId, paymentDate, closedDates } = args;
  if (!cashAccountId || !tillAccountId || !paymentDate) return false;
  if (cashAccountId !== tillAccountId) return false;
  return closedDates.includes(paymentDate);
}

export const TILL_CLOSE_WARNING =
  "That day's cash count is already closed, so cash can't be paid out of the till on it. " +
  "Pick a different payment date, pay from a bank account instead, or ask an admin to reopen the end-of-day close.";
