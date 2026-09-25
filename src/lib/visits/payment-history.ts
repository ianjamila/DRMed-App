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

/**
 * Why a payment was deleted — picked in the Delete dialog and stored as a
 * void_reason prefix ("Recorded twice: <note>", or the label alone when no
 * note was typed), the same way correct_payment stores "Edited: " / "Moved: ".
 * Deletes from before the picker carry no prefix and read as null.
 */
export const DELETE_CATEGORIES = [
  { value: "recorded_twice", label: "Recorded twice" },
  { value: "wrong_visit", label: "Wrong visit" },
  { value: "wrong_amount", label: "Wrong amount" },
  { value: "refunded", label: "Patient refunded" },
  { value: "other", label: "Other" },
] as const;

export type DeleteCategory = (typeof DELETE_CATEGORIES)[number]["value"];

export const DELETE_CATEGORY_VALUES = DELETE_CATEGORIES.map((c) => c.value) as [
  DeleteCategory,
  ...DeleteCategory[],
];

export const DELETE_CATEGORY_LABEL = Object.fromEntries(
  DELETE_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<DeleteCategory, string>;

export function isDeleteCategory(v: string | null | undefined): v is DeleteCategory {
  return (DELETE_CATEGORY_VALUES as readonly string[]).includes(v ?? "");
}

/** The void_reason the Delete action stores. */
export function formatDeleteReason(category: DeleteCategory, note: string): string {
  const n = note.trim();
  return n ? `${DELETE_CATEGORY_LABEL[category]}: ${n}` : DELETE_CATEGORY_LABEL[category];
}

/**
 * A pointer shown under the picked category — Delete is the wrong tool for a
 * payment on the wrong visit or for the wrong amount when Move / Edit can
 * fix it in one step, keeping the original date and cashier.
 */
export function deleteCategoryHint(category: DeleteCategory | "", canMoveOrEdit: boolean): string | null {
  if (category === "wrong_visit") {
    return canMoveOrEdit
      ? "Use Move instead — it puts this payment on the right visit with the same date and cashier."
      : "This payment cannot be moved. Delete it here, then record it again on the right visit.";
  }
  if (category === "wrong_amount") {
    return canMoveOrEdit
      ? "Use Edit instead — it fixes the amount or method and keeps the date and cashier."
      : "This payment cannot be edited. Delete it here, then record the right amount.";
  }
  return null;
}

/**
 * A void_reason split into the prefix it carries and the typed note. The
 * prefixes: correct_payment's "Edited: " / "Moved: " (always followed by a
 * reason) and the Delete categories (the label alone when no note was typed).
 */
export function parseVoidReason(reason: string | null): {
  prefix: "edited" | "moved" | DeleteCategory | null;
  note: string | null;
} {
  if (reason == null) return { prefix: null, note: null };
  const tagged = (label: string) =>
    reason === label || reason.startsWith(`${label}: `)
      ? reason.slice(label.length + 2).trim() || null
      : undefined;
  for (const [label, prefix] of [
    ["Edited", "edited"],
    ["Moved", "moved"],
  ] as const) {
    if (reason.startsWith(`${label}: `)) return { prefix, note: reason.slice(label.length + 2) };
  }
  for (const c of DELETE_CATEGORIES) {
    const note = tagged(c.label);
    if (note !== undefined) return { prefix: c.value, note };
  }
  return { prefix: null, note: reason };
}

/**
 * The staff-typed reason alone, without the prefix correct_payment ("Edited: "
 * / "Moved: ") or the Delete dialog ("Recorded twice: " …) wrote. Null when
 * only a category was picked.
 */
export function stripCorrectionPrefix(reason: string | null): string | null {
  return parseVoidReason(reason).note;
}

/** The Delete category a void_reason carries, if any. */
export function deleteCategoryOf(reason: string | null): DeleteCategory | null {
  const { prefix } = parseVoidReason(reason);
  return prefix === null || prefix === "edited" || prefix === "moved" ? null : prefix;
}

export interface PaymentLinks<T extends HistoryPayment> {
  /** The payment that replaced `p`, when one is loaded. */
  replacementOf(p: T): T | undefined;
  /** The payment `p` replaced, when one is loaded. */
  originalOf(p: T): T | undefined;
  fate(p: T): PaymentFate;
  /** For a payment that replaced another: how it came to be here. */
  arrivedBy(p: T): "edited" | "moved" | null;
  /** The staff-typed reason, without the correction / Delete-category prefix. */
  reason(p: T): string | null;
  /** For a deleted payment: the category picked in the Delete dialog, if any. */
  deleteCategory(p: T): DeleteCategory | null;
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
    deleteCategory: (p) => (fate(p) === "deleted" ? deleteCategoryOf(p.void_reason) : null),
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
