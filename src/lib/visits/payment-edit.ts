// Edit payment (migration 0161, `correct_payment`). The SQL function is the
// source of truth; this module mirrors its rules so the visit page can hide
// the Edit button on a payment the database would refuse, and so the edit
// dialog can say what will happen before anyone presses Save.
// `payment-edit.test.ts` pins the method list against the migration text.

/** The counter methods an edited payment may use — the Record payment form's list minus Gift code. */
export const EDITABLE_PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash" },
  { value: "maya", label: "Maya" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
] as const;

export type EditablePaymentMethod = (typeof EDITABLE_PAYMENT_METHODS)[number]["value"];

export function isEditablePaymentMethod(m: string | null | undefined): m is EditablePaymentMethod {
  return EDITABLE_PAYMENT_METHODS.some((x) => x.value === m);
}

export interface EditablePaymentRow {
  method: string | null;
  voided_at: string | null;
  legacy_import_run_id: string | null;
}

export type PaymentEditability =
  | { editable: true }
  | { editable: false; reason: string };

/**
 * Whether Edit is offered for a payment. Mirrors correct_payment's refusals:
 * voided rows, gift-code redemptions and HMO settlements, and rows from the
 * legacy history import. Every one of them can still be deleted (voided).
 * Move (a correction onto another visit) refuses exactly the same rows.
 */
export function paymentEditability(
  p: EditablePaymentRow,
  verb: "edited" | "moved" = "edited",
): PaymentEditability {
  if (p.voided_at) {
    return { editable: false, reason: "This payment was already deleted or edited." };
  }
  if (p.method === "gift_code" || p.method === "hmo") {
    return {
      editable: false,
      reason: `Gift code and HMO payments cannot be ${verb}. Delete it and record it again.`,
    };
  }
  if (p.legacy_import_run_id) {
    return {
      editable: false,
      reason: `Payments from the imported history cannot be ${verb}. Delete it and record it again.`,
    };
  }
  return { editable: true };
}

/**
 * True when the edit changes the money (amount or method). A money change
 * voids the original and records a corrected payment; a reference/notes-only
 * edit updates the payment in place and leaves the books alone.
 */
export function isMoneyChange(
  before: { amount_php: number; method: string | null },
  after: { amount_php: number; method: string },
): boolean {
  return toCentavos(before.amount_php) !== toCentavos(after.amount_php) || before.method !== after.method;
}

/**
 * The visit balance after the edit, in pesos (negative = overpaid). Centavo
 * arithmetic so ₱0.25 steps do not drift.
 */
export function balanceAfterEdit(input: {
  visitTotal: number;
  visitPaid: number;
  oldAmount: number;
  newAmount: number;
}): number {
  const c =
    toCentavos(input.visitTotal) -
    toCentavos(input.visitPaid) +
    toCentavos(input.oldAmount) -
    toCentavos(input.newAmount);
  return c / 100;
}

function toCentavos(php: number): number {
  return Math.round(php * 100);
}
