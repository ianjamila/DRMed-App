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

/**
 * A raw `test_requests` row as both receipt pages and the group print action
 * select it. `services` is typed loosely because PostgREST returns an embedded
 * to-one either as an object or as a one-element array depending on how the
 * relationship is inferred, and each caller selects a different column set off
 * it — only `price_php` is read here.
 */
export interface RawReceiptLine<S> {
  id: string;
  deleted_at: string | null;
  base_price_php: number | null;
  discount_kind?: string | null;
  discount_amount_php: number | null;
  final_price_php: number | null;
  services: S | S[] | null;
}

export interface MappedReceiptLine<S>
  extends PricedReceiptLine,
    DeletableReceiptLine {
  id: string;
  svc: S | undefined;
  discountKind: string | null;
}

/**
 * Map one raw row into the priced, deletable shape the receipts render and
 * total from.
 *
 * This lived inline and identically in both receipt pages until the group
 * print action needed the same numbers: the audit row's `total_php` has to be
 * the figure that was on the paper, so it must be derived by exactly the same
 * fallback chain (`base_price_php` → the service's list price → 0, and
 * `final_price_php` → base − discount) rather than a second one that drifts.
 */
export function toReceiptLine<S extends { price_php?: number | null }>(
  tr: RawReceiptLine<S>,
): MappedReceiptLine<S> {
  const embedded = Array.isArray(tr.services) ? tr.services[0] : tr.services;
  const svc = embedded ?? undefined;
  const base = tr.base_price_php ?? svc?.price_php ?? 0;
  const discount = tr.discount_amount_php ?? 0;
  const final = tr.final_price_php ?? base - discount;
  return {
    id: tr.id,
    svc,
    base,
    discount,
    final,
    discountKind: tr.discount_kind ?? null,
    deleted: tr.deleted_at !== null,
  };
}
