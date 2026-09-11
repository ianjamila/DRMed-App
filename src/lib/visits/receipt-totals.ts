/**
 * Pure receipt-line totalling shared by both receipt pages (single-visit and
 * the combined group receipt).
 *
 * A soft-deleted test line (0125) must never appear on a reprinted receipt,
 * nor count toward its subtotal / discount / total — the visit's queue no
 * longer shows the test, so charging for it (or even listing it) on a
 * reprint is a silent billing error (N8). Both receipt pages map raw
 * `test_requests` rows into a shape carrying a `deleted` flag derived from
 * `deleted_at`, then call `visibleReceiptLines` before rendering or totalling
 * — never reduce over the raw mapped array directly, so a soft-delete fixed
 * on one receipt can't be forgotten on the other.
 *
 * No `server-only` import — unit-testable, and safe to use from either
 * Server Component.
 */

export interface DeletableReceiptLine {
  deleted: boolean;
}

export interface PricedReceiptLine {
  base: number;
  discount: number;
  final: number;
}

/** Lines that should actually render on a receipt — soft-deleted ones excluded. */
export function visibleReceiptLines<T extends DeletableReceiptLine>(
  lines: readonly T[],
): T[] {
  return lines.filter((l) => !l.deleted);
}

export interface ReceiptTotals {
  subtotal: number;
  totalDiscount: number;
  total: number;
}

/**
 * Subtotal / discount / total. Callers must pass already-filtered lines
 * (`visibleReceiptLines`) — a soft-deleted line must never reach this
 * function on a live receipt page, but the function itself doesn't filter so
 * a caller building a deliberate "all lines including deleted" audit view
 * still can.
 */
export function receiptTotals(
  lines: readonly PricedReceiptLine[],
): ReceiptTotals {
  return {
    subtotal: lines.reduce((s, l) => s + Number(l.base), 0),
    totalDiscount: lines.reduce((s, l) => s + Number(l.discount), 0),
    total: lines.reduce((s, l) => s + Number(l.final), 0),
  };
}
