/**
 * Groups a period's cash-account journal lines into the cash-flow page's
 * per-category waterfall (keyed by `journal_entries.source_kind`).
 *
 * A reversal mirror (`source_kind = 'reversal'`) is filed under the category
 * of the entry it reverses, not under a "JE reversals" row of its own. Filed
 * separately, an undone ₱1,500 payment showed +₱1,500 under payments and
 * −₱1,500 under reversals: the net total was right, but both categories'
 * gross figures were inflated by money that never moved.
 *
 *   - Original posted IN the period: the mirror cancels it inside its own
 *     category — a mirror credit takes back the original's debit from
 *     `inflow`, and vice versa — and the pair drops out of `count`, as if the
 *     undone entry had never posted (the same rule as LEDGER_TOTAL_STATUSES).
 *   - Original posted BEFORE the period: nothing in this period to cancel,
 *     so the mirror is an ordinary movement in the original's category (an
 *     undone August payment is a September outflow under payments).
 *   - Original unknown (no `reverses`, or the embed came back empty): stays
 *     under `reversal`, so the money is never dropped.
 */

export interface CashFlowLine {
  debit_php: number | string | null;
  credit_php: number | string | null;
  journal_entries: {
    source_kind: string;
    /** The entry this mirror reverses (0173's `reverses` FK). */
    original?: { source_kind: string; posting_date: string } | null;
  } | null;
}

export interface CashFlowBucket {
  inflow: number;
  outflow: number;
  count: number;
}

export function bucketCashMovements(
  lines: readonly CashFlowLine[],
  period: { start: string; end: string },
): Map<string, CashFlowBucket> {
  const buckets = new Map<string, CashFlowBucket>();

  for (const row of lines) {
    const je = row.journal_entries;
    const d = Number(row.debit_php ?? 0);
    const c = Number(row.credit_php ?? 0);

    const original = je?.source_kind === "reversal" ? je.original : null;
    const key = original?.source_kind ?? je?.source_kind ?? "manual";
    const bucket = buckets.get(key) ?? { inflow: 0, outflow: 0, count: 0 };

    const cancelsInPeriod =
      !!original &&
      original.posting_date >= period.start &&
      original.posting_date <= period.end;

    if (cancelsInPeriod) {
      // The original's debit (inflow) comes back as this line's credit, and
      // its credit (outflow) as this line's debit.
      bucket.inflow -= c;
      bucket.outflow -= d;
      bucket.count -= 1;
    } else {
      if (d > 0) bucket.inflow += d;
      if (c > 0) bucket.outflow += c;
      bucket.count += 1;
    }
    buckets.set(key, bucket);
  }

  for (const [key, b] of buckets) {
    // Cancelling by subtraction leaves float dust (0.1 + 0.2 - 0.3); the
    // ledger is in centavos, so round back to them.
    b.inflow = Math.round(b.inflow * 100) / 100;
    b.outflow = Math.round(b.outflow * 100) / 100;
    // A category whose every line was undone inside the period moved no money.
    if (b.count === 0 && b.inflow === 0 && b.outflow === 0) buckets.delete(key);
  }
  return buckets;
}
