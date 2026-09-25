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

export type BalanceLabel = "Balance due" | "Balance" | "Paid in full" | "Overpaid";

export interface StatementSummary {
  charges: number;
  paid: number;
  /** charges − paid; negative when more was paid than charged. */
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
  opts: { hmoBilled: boolean },
): StatementSummary {
  const paid =
    livePayments(payments).reduce((s, p) => s + cents(Number(p.amount_php)), 0) / 100;
  const balance = (cents(charges) - cents(paid)) / 100;
  let balanceLabel: BalanceLabel;
  if (balance === 0) balanceLabel = "Paid in full";
  else if (balance < 0) balanceLabel = "Overpaid";
  // An HMO visit never pays its share at the counter — the claim settles it —
  // so an open balance is not something the patient owes today.
  else balanceLabel = opts.hmoBilled ? "Balance" : "Balance due";
  return { charges, paid, balance, balanceLabel };
}

/**
 * Who may open, print or email a statement: the money paper's audience — the
 * same roles that see the visit page's payments section.
 */
export const STATEMENT_ROLES: ReadonlySet<string> = new Set(["reception", "admin"]);
