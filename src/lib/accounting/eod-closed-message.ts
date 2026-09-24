import { friendlyManilaDate, isISODate } from "@/lib/dates/manila";

/**
 * P0015 (the day-close lock) in words reception can act on.
 *
 * 0043's `eod_lock_check` raises "EOD already closed for business_date
 * 2026-09-24 (shift AM) at 2026-09-24 02:15:32+00. Ask an admin to reopen the
 * close before recording further activity." — a column name, a shift code and
 * a raw UTC instant. `translatePgError` used to pass that through verbatim, so
 * its friendlier fallback was never shown. Keep only the date, said the way
 * the End of Day tab says it.
 *
 * AP payments have their own wording (`bill-payment-errors.ts`), because a
 * bookkeeper has different ways out than reception.
 */
export function eodClosedMessage(dbMessage?: string): string {
  const date = dbMessage?.match(/business_date (\d{4}-\d{2}-\d{2})/)?.[1];
  // A real calendar date, not just the shape: friendlyManilaDate throws on
  // 2026-13-45, and an error translator must never become the error.
  return isISODate(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    ? `End of Day is already closed for ${friendlyManilaDate(date)}, so nothing more can be recorded on that day. Ask an admin to reopen it first.`
    : "End of Day is already closed for that date, so nothing more can be recorded on it. Ask an admin to reopen it first.";
}
