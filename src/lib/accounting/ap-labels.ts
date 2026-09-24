/**
 * Words for the Expenses (AP subledger) enums: `bills.status` and
 * `bill_payments.method`. Every Expenses screen that shows either one — the
 * bills and payments lists and filters, bill and payment detail, the New bill
 * and New payment forms, and the vendor page — reads these instead of printing
 * the stored code. `ap-labels.test.ts` pins both lists to the CHECK
 * constraints in 0048.
 *
 * Pure logic (no `server-only`, no DB) so server and client components can
 * import it.
 */

import { humaniseCode } from "@/lib/format/humanise-code";

export const BILL_STATUSES = ["draft", "posted", "partially_paid", "paid", "voided"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_STATUS_LABEL: Record<BillStatus, string> = {
  draft: "Draft",
  posted: "Posted",
  partially_paid: "Partially paid",
  paid: "Paid",
  voided: "Voided",
};

export const BILL_PAYMENT_METHODS = ["cash", "bank_transfer", "gcash", "cheque"] as const;
export type BillPaymentMethod = (typeof BILL_PAYMENT_METHODS)[number];

export const BILL_PAYMENT_METHOD_LABEL: Record<BillPaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  cheque: "Cheque",
};

export function billStatusLabel(status: string): string {
  return BILL_STATUS_LABEL[status as BillStatus] ?? humaniseCode(status);
}

export function billPaymentMethodLabel(method: string): string {
  return BILL_PAYMENT_METHOD_LABEL[method as BillPaymentMethod] ?? humaniseCode(method);
}
