export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  partial: "Partially paid",
  paid: "Paid",
  waived: "Waived",
};

export function paymentStatusLabel(s: string): string {
  return PAYMENT_STATUS_LABEL[s] ?? s.replace(/_/g, " ");
}
