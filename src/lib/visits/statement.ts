/**
 * The money summary under a visit's statement of account: what was charged,
 * what was paid, and what is left.
 *
 * The statement is the paper a patient asks for when they need proof of what
 * a visit cost and what they paid — a reimbursement claim, a company, a
 * consult-only visit that prints no receipt. It must add up on its own face,
 * so the paid figure is summed from the payments it lists (voided ones never
 * reach it) rather than read from `visits.paid_php`, and the balance is
 * charges − that sum.
 *
 * Pure and dependency-free, so it is unit-tested.
 */

export interface StatementPayment {
  amount_php: number | string;
  voided_at: string | null;
}

export type BalanceLabel = "Balance due" | "Balance" | "Paid in full" | "Overpaid" | "Nothing due";

export interface StatementSummary {
  charges: number;
  paid: number;
  /**
   * The remainder the clinic waived (`payment_status = 'waived'`): charity,
   * no-charge. Waiving writes no payment row, so without this a waived visit
   * would read "Balance due" and ask the patient for money nobody expects.
   */
  waived: number;
  /** charges − paid − waived; negative when more was paid than charged. */
  balance: number;
  balanceLabel: BalanceLabel;
}

/** Payments that count: everything not voided (0111). */
export function livePayments<P extends StatementPayment>(payments: readonly P[]): P[] {
  return payments.filter((p) => p.voided_at === null);
}

// Peso amounts are numeric(12,2); compare in centavos so 0.1 + 0.2 style
// float noise never turns "Paid in full" into a one-centavo balance.
const cents = (n: number) => Math.round(n * 100);

export function statementSummary(
  charges: number,
  payments: readonly StatementPayment[],
  opts: { hmoBilled: boolean; waived: boolean },
): StatementSummary {
  const paid =
    livePayments(payments).reduce((s, p) => s + cents(Number(p.amount_php)), 0) / 100;
  const owed = (cents(charges) - cents(paid)) / 100;
  if (opts.waived && owed > 0) {
    return { charges, paid, waived: owed, balance: 0, balanceLabel: "Nothing due" };
  }
  const balance = owed;
  let balanceLabel: BalanceLabel;
  if (balance === 0) balanceLabel = "Paid in full";
  else if (balance < 0) balanceLabel = "Overpaid";
  // An HMO visit never pays its share at the counter — the claim settles it —
  // so an open balance is not something the patient owes today.
  else balanceLabel = opts.hmoBilled ? "Balance" : "Balance due";
  return { charges, paid, waived: 0, balance, balanceLabel };
}

/** The money columns a list page already reads off each `visits` row. */
export interface VisitMoneyRow {
  payment_status: string;
  total_php: number | string;
  paid_php: number | string;
  hmo_provider_id: string | null;
}

/**
 * The statement's summary from the visit row alone, for list pages (Reception
 * Queue, the patient page's Visits, the portal's "Your visits") that don't
 * load payments. `paid_php` is the live-payment sum the payments trigger keeps
 * (0111), so this agrees with the statement without a payments read.
 */
export function visitMoneySummary(v: VisitMoneyRow): StatementSummary {
  return statementSummary(Number(v.total_php), [{ amount_php: v.paid_php, voided_at: null }], {
    hmoBilled: v.hmo_provider_id != null,
    waived: v.payment_status === "waived",
  });
}

/** How much of a visit's bill the clinic waived; 0 unless it is `waived`. */
export function waivedAmount(v: Omit<VisitMoneyRow, "hmo_provider_id">): number {
  return visitMoneySummary({ ...v, hmo_provider_id: null }).waived;
}

/**
 * Who may open, print or email a statement: the money paper's audience — the
 * same roles that see the visit page's payments section.
 */
export const STATEMENT_ROLES: ReadonlySet<string> = new Set(["reception", "admin"]);
