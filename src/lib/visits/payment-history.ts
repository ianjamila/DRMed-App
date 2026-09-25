// What happened to a payment: still standing, edited, moved to another visit,
// or deleted. One reading of `corrects_payment_id` + `voided_at` (0161) shared
// by the visit page, the patient page and the Payment Changes report, so all
// three tell the same story about the same row.
//
// A voided payment that some other payment `corrects` was replaced by it: an
// edit when the replacement sits on the same visit, a move when it does not.
// A voided payment nothing replaces was deleted.

import { PAYMENT_METHOD_LABEL } from "@/lib/accounting/money-routing";
import { humaniseCode } from "@/lib/format/humanise-code";

export type PaymentFate = "active" | "edited" | "moved" | "deleted";

/** The one label map for a stored payments.method (money-routing owns it). */
export function paymentMethodLabel(m: string | null): string {
  if (!m) return "—";
  return PAYMENT_METHOD_LABEL[m] ?? humaniseCode(m);
}

export interface HistoryPayment {
  id: string;
  visit_id: string;
  amount_php: number | string;
  method: string | null;
  voided_at: string | null;
  void_reason: string | null;
  corrects_payment_id: string | null;
}

/** correct_payment writes 'Edited: <reason>' / 'Moved: <reason>'; this is the reason alone. */
export function stripCorrectionPrefix(reason: string | null): string | null {
  if (reason == null) return null;
  return reason.replace(/^(Edited|Moved): /, "");
}

export interface PaymentLinks<T extends HistoryPayment> {
  /** The payment that replaced `p`, when one is loaded. */
  replacementOf(p: T): T | undefined;
  /** The payment `p` replaced, when one is loaded. */
  originalOf(p: T): T | undefined;
  fate(p: T): PaymentFate;
  /** For a payment that replaced another: how it came to be here. */
  arrivedBy(p: T): "edited" | "moved" | null;
  /** The staff-typed reason, without the correction prefix. */
  reason(p: T): string | null;
}

/**
 * Index a set of payment rows by their correction links. Pass every row the
 * page loaded — including the linked rows that sit on OTHER visits — or a
 * move will read as an edit/delete on one side of it.
 */
export function linkPayments<T extends HistoryPayment>(rows: readonly T[]): PaymentLinks<T> {
  const byId = new Map<string, T>();
  const replacementById = new Map<string, T>();
  for (const r of rows) {
    byId.set(r.id, r);
    if (r.corrects_payment_id) replacementById.set(r.corrects_payment_id, r);
  }

  const fate = (p: T): PaymentFate => {
    if (!p.voided_at) return "active";
    const rep = replacementById.get(p.id);
    if (rep) return rep.visit_id === p.visit_id ? "edited" : "moved";
    // The replacement row was not loaded (e.g. the report's window cut it
    // off): fall back to the prefix correct_payment wrote.
    if (p.void_reason?.startsWith("Moved: ")) return "moved";
    if (p.void_reason?.startsWith("Edited: ")) return "edited";
    return "deleted";
  };

  return {
    replacementOf: (p) => replacementById.get(p.id),
    originalOf: (p) => (p.corrects_payment_id ? byId.get(p.corrects_payment_id) : undefined),
    fate,
    arrivedBy: (p) => {
      if (!p.corrects_payment_id) return null;
      const orig = byId.get(p.corrects_payment_id);
      if (orig) return orig.visit_id === p.visit_id ? "edited" : "moved";
      return "edited";
    },
    reason: (p) => (p.voided_at ? stripCorrectionPrefix(p.void_reason) : null),
  };
}

export const PAYMENT_FATE_LABEL: Record<PaymentFate, string> = {
  active: "Active",
  edited: "Edited",
  moved: "Moved",
  deleted: "Deleted",
};

/** The ids a page must also load to resolve links that cross visits. */
export function crossVisitLinkIds(rows: readonly HistoryPayment[]): {
  replacementsOf: string[];
  originals: string[];
} {
  const ids = new Set(rows.map((r) => r.id));
  return {
    replacementsOf: rows.filter((r) => r.voided_at).map((r) => r.id),
    originals: [
      ...new Set(
        rows
          .map((r) => r.corrects_payment_id)
          .filter((id): id is string => id != null && !ids.has(id)),
      ),
    ],
  };
}
