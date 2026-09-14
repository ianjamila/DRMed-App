/**
 * Shared maps for expense encoding: category → DR CoA code, MOP → CR CoA code.
 *
 * Used by:
 *   - scripts/history-import/expenses.ts (historic xlsx → JE)
 *   - app: /staff/admin/accounting/ap/quick-expense (in-app entry form)
 *
 * Keep in sync — if you add a category here, also seed the CoA code.
 */

export type ExpenseCategory =
  | "Salaries & Wages"
  | "Doctors Payroll"
  | "Benefits"
  | "Past HMO of Doctors"
  | "Rent"
  | "Utilities"
  | "Telecommunication / Internet"
  | "Maintenance & Repair"
  | "Office Supplies"
  | "Lab Supplies"
  | "Send Out"
  | "Marketing: Ads & Promotion"
  | "Permits"
  | "Legal & Regulatory"
  | "Insurance"
  | "Travel"
  | "APE"
  | "Out of Pocket Expense";

export const CATEGORY_TO_COA: Record<ExpenseCategory, string> = {
  "Salaries & Wages": "6100",
  "Doctors Payroll": "6110",
  Benefits: "6120",
  "Past HMO of Doctors": "6120",
  Rent: "6200",
  Utilities: "6210",
  "Telecommunication / Internet": "6220",
  "Maintenance & Repair": "6310",
  "Office Supplies": "6400",
  "Lab Supplies": "6410",
  "Send Out": "6420",
  "Marketing: Ads & Promotion": "6500",
  Permits: "6600",
  "Legal & Regulatory": "6610",
  Insurance: "6620",
  Travel: "6700",
  APE: "6710",
  "Out of Pocket Expense": "9999",
};

export const EXPENSE_CATEGORIES: ExpenseCategory[] = Object.keys(
  CATEGORY_TO_COA,
) as ExpenseCategory[];

/**
 * Categories reception may book against PETTY CASH (the `/staff/payments/petty-cash`
 * form). A deliberate subset of the admin list:
 *   - Excludes owner / payroll-level accounts reception shouldn't touch:
 *     Salaries & Wages, Doctors Payroll, Benefits, Past HMO of Doctors, Rent,
 *     Insurance, Legal & Regulatory, APE.
 *   - Excludes "Out of Pocket Expense" (maps to 9999 SUSPENSE) — the books
 *     reconciliation cleared that account to ₱0; petty cash must not re-pollute it.
 * Each entry carries a plain-language hint (reception pages use everyday words).
 */
export const PETTY_CASH_CATEGORY_OPTIONS: {
  value: ExpenseCategory;
  hint: string;
}[] = [
  { value: "Office Supplies", hint: "Bond paper, ink, pens, folders, cleaning supplies" },
  { value: "Lab Supplies", hint: "Small lab consumables bought with cash" },
  { value: "Maintenance & Repair", hint: "Minor fixes — aircon cleaning, light bulbs, plumbing" },
  { value: "Travel", hint: "Fares, courier / delivery, gas reimbursements" },
  { value: "Permits", hint: "Government fees, permit renewals, notarial" },
  { value: "Utilities", hint: "Small cash top-ups for water / power" },
  { value: "Telecommunication / Internet", hint: "Prepaid load, small internet top-ups" },
  { value: "Marketing: Ads & Promotion", hint: "Flyers, tarpaulins, small print jobs" },
];

export const PETTY_CASH_CATEGORIES: ExpenseCategory[] =
  PETTY_CASH_CATEGORY_OPTIONS.map((o) => o.value);

export type Mop =
  | "CLINIC CASH"
  | "CLINIC GCASH"
  | "CHEQUE"
  | "BPI"
  | "BDO"
  | "IAN"
  | "FREYA";

export const MOP_TO_COA: Record<Mop, string> = {
  "CLINIC CASH": "1010",
  "CLINIC GCASH": "1030",
  CHEQUE: "1020",
  BPI: "1020",
  BDO: "1021",
  IAN: "2500",
  FREYA: "2500",
};

/**
 * The one MOP that is physical cash out of the reception till (CR 1010).
 *
 * Anything paid this way MUST be written as an `eod_cash_adjustments` row
 * (`kind='petty_cash'`) rather than as a direct journal entry, because
 * `cash_drawer_state.expected_cash_php` derives the day's payouts *solely*
 * from that table — it never reads `journal_entries`, and the bridge trigger
 * runs one way only (adjustment → JE, never the reverse).
 *
 * Posting the JE directly instead moves the books but not the drawer: reception
 * counts short, the EOD close books the shortage to 6900 Cash Short/Over, and
 * the same peso gets credited to cash twice. `postTillCashExpense()` is the
 * only correct writer; `postExpenseJournalEntry()` refuses this MOP outright so
 * a future caller can't quietly reopen the hole.
 */
export const TILL_CASH_MOP = "CLINIC CASH" as const satisfies Mop;

/** True when a payment source is physical cash out of the till (see TILL_CASH_MOP). */
export function isTillCashMop(mop: Mop): boolean {
  return mop === TILL_CASH_MOP;
}

/**
 * Reverse of `CATEGORY_TO_COA`, restricted to the petty-cash subset.
 *
 * A till expense stores its category as `eod_cash_adjustments.contra_account_id`,
 * so the Petty cash history list maps the account back to the everyday phrase
 * reception picked. Restricted to the subset on purpose: the full map is not
 * injective (Benefits and "Past HMO of Doctors" share 6120), whereas the eight
 * petty-cash categories are one-to-one. Anything outside the subset — an admin
 * Quick expense booked to, say, Rent — falls back to the account name.
 */
export const PETTY_CASH_COA_TO_CATEGORY: Record<string, ExpenseCategory> =
  Object.fromEntries(
    PETTY_CASH_CATEGORY_OPTIONS.map((o) => [CATEGORY_TO_COA[o.value], o.value]),
  );

export const MOP_OPTIONS: { value: Mop; label: string; hint: string }[] = [
  { value: "CLINIC CASH", label: "Clinic Cash", hint: "Cash out of the reception till — recorded as a drawer payout, not a plain journal entry" },
  { value: "CLINIC GCASH", label: "Clinic GCash", hint: "Paid from clinic's GCash wallet" },
  { value: "CHEQUE", label: "Cheque (BPI)", hint: "Cheque drawn from BPI account" },
  { value: "BPI", label: "BPI transfer", hint: "Direct transfer from BPI" },
  { value: "BDO", label: "BDO transfer", hint: "Direct transfer from BDO" },
  { value: "IAN", label: "Ian's pocket", hint: "Owner Ian paid from personal money — recorded as Due to Shareholders" },
  { value: "FREYA", label: "Freya's pocket", hint: "Owner Freya paid from personal money — recorded as Due to Shareholders" },
];
