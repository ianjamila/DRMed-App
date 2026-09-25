import { formatPhp } from "@/lib/marketing/format";
import {
  paymentLeavesMessage,
  paymentLeavesState,
  type ReleasedCounts,
  type VisitMoney,
} from "@/lib/visits/payment-edit";

/**
 * What a visit is left in when a payment leaves it — the Delete dialog and
 * the source side of Move. A preview of the figures the page loaded; the
 * action re-reads the visit when it runs. Renders nothing when the visit
 * stays settled (e.g. a payment recorded twice).
 */
export function PaymentLeavesNotice({
  visit,
  visitNumber,
  amount,
  released,
  className = "",
}: {
  visit: VisitMoney;
  visitNumber: string;
  amount: number;
  released: ReleasedCounts;
  className?: string;
}) {
  const state = paymentLeavesState(visit, amount, released);
  if (!state) return null;
  const { text, emphasis } = paymentLeavesMessage(state, visitNumber, formatPhp);
  return (
    <p
      className={`${className} ${emphasis ? "font-semibold text-amber-800" : ""}`.trim()}
      data-testid="payment-leaves-notice"
    >
      {text}
    </p>
  );
}
