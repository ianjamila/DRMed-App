/**
 * Plain names and rules for "where money is recorded" — shared by the Money
 * Routing admin page and the Cash Drawer's account picker. Pure and
 * dependency-free so both the server actions and the client forms can use it.
 *
 * Two maps drive the GL bridge:
 *  - `payment_method_account_map` (0030): payment method → the cash/bank
 *    account a patient payment lands in.
 *  - `cash_adjustment_account_map` (0043): cash-drawer entry kind → the other
 *    side of its journal entry. With `requires_user_choice` on, reception picks
 *    the account on the Cash Drawer; a blank pick falls back to 9999 Suspense
 *    (`resolve_cash_adjustment_account`), so the mapped account is only the
 *    starting pick the Cash Drawer pre-fills.
 */

import { CATEGORY_TO_COA, PETTY_CASH_CATEGORY_OPTIONS } from "./expense-mappings";

export type RoutingAccount = { id: string; code: string; name: string; type: string };

/** The GL fallback that means "nobody chose an account". Never pre-filled. */
export const SUSPENSE_CODE = "9999";

// ---- Plain names ------------------------------------------------------------

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  gcash: "GCash",
  maya: "Maya",
  bpi: "BPI",
  maybank: "Maybank",
  bank_transfer: "Bank transfer",
  hmo: "HMO",
  gift_code: "Gift code",
};

/** Plain-English labels for the stored cash-drawer `kind` codes, so nobody
 *  sees raw values like "petty_cash" or "float_topup". */
export const CASH_KIND_LABEL: Record<string, string> = {
  petty_cash: "Petty cash",
  salary_advance: "Salary advance",
  courier: "Courier / delivery",
  other_payout: "Other",
  float_topup: "Cash added to drawer",
  float_pullout: "Cash removed from drawer",
  // A cash salary payout from /cash-drawer (0044).
  salary_payout: "Salary payout",
  // N14 (0139): a cash gift-code sale.
  gift_code_sale: "Gift code sold",
  // 0149: written by the AP subledger, not by the Cash Drawer — a supplier
  // bill paid in cash out of the till. It has no routing row.
  bill_payment: "Supplier bill paid",
};

function humanize(code: string): string {
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const paymentMethodLabel = (m: string) => PAYMENT_METHOD_LABEL[m] ?? humanize(m);
export const cashKindLabel = (k: string) => CASH_KIND_LABEL[k] ?? humanize(k);

/** One line on what each cash-drawer entry is, for the Money Routing page. */
export const CASH_KIND_HELP: Record<string, string> = {
  petty_cash: "Small purchases paid from the drawer.",
  courier: "Courier and delivery fees paid from the drawer.",
  other_payout: "Any other cash paid out of the drawer.",
  float_topup: "Cash put into the drawer, e.g. from the bank or the owner.",
  float_pullout: "Cash taken out of the drawer, e.g. a bank deposit.",
  salary_advance: "Cash lent to a staff member before payday.",
  salary_payout: "Net pay handed out in cash on payday.",
  gift_code_sale: "Cash received when a gift code is sold.",
};

// ---- Rows the books depend on ----------------------------------------------

/**
 * Rows that must never be re-pointed: another part of the system posts the
 * opposite side to one hardcoded account, so moving this side would leave that
 * account permanently out of balance. The value is the reason shown on screen.
 */
export const FIXED_PAYMENT_METHODS: Record<string, string> = {
  // 0139: redemption debits the liability created when the code was sold.
  gift_code: "Paying with a gift code uses up what the clinic owes on that code, so it always comes out of 2250.",
};

export const FIXED_CASH_KINDS: Record<string, string> = {
  // 0044 payroll finalise credits 1130 when it deducts the advance.
  salary_advance: "Payroll deducts advances from 1130 Staff Advances, so the advance must be recorded there too.",
  // 0044 payroll finalise credits 2360 with net pay; the payout clears it.
  salary_payout: "Payroll records net pay as owed in 2360 Salaries Payable, and paying it out clears that same account.",
  // 0139: the redemption payment later debits the same liability.
  gift_code_sale: "A sold gift code is money the clinic owes until it is used, and using it takes the amount back out of 2250.",
};

export const isFixedPaymentMethod = (m: string) => m in FIXED_PAYMENT_METHODS;
export const isFixedCashKind = (k: string) => k in FIXED_CASH_KINDS;

export type CashRoutingGroup = "staff_picks" | "always" | "fixed";

/** Which of the three groups a cash-drawer row belongs to on the page. */
export function cashRoutingGroup(kind: string, requiresUserChoice: boolean): CashRoutingGroup {
  if (isFixedCashKind(kind)) return "fixed";
  return requiresUserChoice ? "staff_picks" : "always";
}

// ---- Which accounts make sense for a row ------------------------------------

const isCashOrBank = (a: RoutingAccount) => a.type === "asset" && a.code.startsWith("10");

/** The accounts behind the Petty Cash tab's plain categories — reception books
 *  petty cash against these and nothing else (see PETTY_CASH_CATEGORY_OPTIONS). */
const PETTY_CASH_CODES = new Set(PETTY_CASH_CATEGORY_OPTIONS.map((o) => CATEGORY_TO_COA[o.value]));

/** The Petty Cash tab's categories, resolved to active accounts, so the Cash
 *  Drawer's "Pay out cash → Petty cash" offers the same short plain list. */
export function pettyCashChoices(
  accounts: readonly RoutingAccount[],
): { category: string; hint: string; account: RoutingAccount }[] {
  return PETTY_CASH_CATEGORY_OPTIONS.flatMap((o) => {
    const account = accounts.find((a) => a.code === CATEGORY_TO_COA[o.value]);
    return account ? [{ category: o.value, hint: o.hint, account }] : [];
  });
}

/**
 * The accounts worth offering for a row, so a dropdown lists a handful instead
 * of the whole chart. `other_payout` stays open (it is "anything else"). The
 * row's current account is always kept, so an unusual existing mapping is
 * never hidden or silently changed by opening the editor.
 */
export function accountChoicesFor(
  target: { side: "payment" | "cash"; key: string },
  accounts: readonly RoutingAccount[],
  currentAccountId?: string | null,
): RoutingAccount[] {
  const allowed = (a: RoutingAccount): boolean => {
    if (target.side === "payment") return isCashOrBank(a);
    switch (target.key) {
      case "petty_cash":
        return a.type === "expense" && PETTY_CASH_CODES.has(a.code);
      case "courier":
        return a.type === "expense";
      case "float_topup":
      case "float_pullout":
        return isCashOrBank(a) || a.type === "equity" || a.type === "liability";
      default:
        return true;
    }
  };
  return accounts.filter((a) => a.id === currentAccountId || allowed(a));
}

export function isAllowedAccount(
  target: { side: "payment" | "cash"; key: string },
  account: RoutingAccount,
  currentAccountId?: string | null,
): boolean {
  return accountChoicesFor(target, [account], currentAccountId).length === 1;
}

const GROUP_ORDER: { label: string; test: (a: RoutingAccount) => boolean }[] = [
  { label: "Cash & bank", test: isCashOrBank },
  { label: "Expenses", test: (a) => a.type === "expense" },
  { label: "Other assets", test: (a) => a.type === "asset" },
  { label: "Liabilities", test: (a) => a.type === "liability" },
  { label: "Equity", test: (a) => a.type === "equity" },
  { label: "Revenue", test: (a) => a.type === "revenue" || a.type === "contra_revenue" },
  { label: "Other", test: () => true },
];

/** Split a choice list into labelled `<optgroup>`s, keeping code order inside each. */
export function groupAccounts(accounts: readonly RoutingAccount[]): { label: string; accounts: RoutingAccount[] }[] {
  const groups = GROUP_ORDER.map((g) => ({ label: g.label, accounts: [] as RoutingAccount[] }));
  for (const a of accounts) {
    const i = GROUP_ORDER.findIndex((g) => g.test(a));
    groups[i].accounts.push(a);
  }
  return groups.filter((g) => g.accounts.length > 0);
}

// ---- The Cash Drawer's picker ------------------------------------------------

export type CashRule = { account_id: string; requires_user_choice: boolean };

/**
 * Whether reception picks the account on the Cash Drawer for this kind. Follows
 * the routing row; without one, falls back to the rule the form hardcoded
 * before the row existed (advances and courier never showed a picker).
 */
export function staffPicksAccount(kind: string, rule: CashRule | undefined): boolean {
  if (rule) return rule.requires_user_choice;
  return kind !== "salary_advance" && kind !== "courier";
}

/**
 * The account the Cash Drawer's picker starts on: the routing row's account,
 * unless that is 9999 Suspense — pre-filling Suspense would post there
 * explicitly and skip the "nobody chose" audit the blank fallback writes.
 */
export function startingPick(
  rule: CashRule | undefined,
  accounts: readonly RoutingAccount[],
): string {
  if (!rule || !rule.requires_user_choice) return "";
  const account = accounts.find((a) => a.id === rule.account_id);
  if (!account || account.code === SUSPENSE_CODE) return "";
  return account.id;
}

/**
 * Mirrors `resolve_cash_adjustment_account` (0043): the account code an
 * `eod_cash_adjustments` row will actually post to, whether or not the
 * account picker is even shown. An explicit contra pick always wins;
 * otherwise the routing row decides — unless it requires a staff pick (and
 * `startingPick` above never pre-fills one), in which case the DB posts to
 * 9999 Suspense rather than the mapped default.
 *
 * Lets a caller (e.g. "is this a Send Out payout?") test the account the
 * database will actually use, not just whatever a hidden picker happens to
 * hold — `staffPicksAccount(kind, rule) === false` means no picker renders
 * at all, so `contraAccountId` is always empty for that kind.
 */
export function effectiveCashAccountCode(
  contraAccountId: string | null | undefined,
  rule: CashRule | undefined,
  accounts: readonly RoutingAccount[],
): string | undefined {
  if (contraAccountId) return accounts.find((a) => a.id === contraAccountId)?.code;
  if (!rule || rule.requires_user_choice) return SUSPENSE_CODE;
  return accounts.find((a) => a.id === rule.account_id)?.code;
}

/** A chart row as the SERVER sees it — including switched-off accounts, which
 *  the Cash Drawer page never sends to the browser. */
export type CashAccountRow = { id: string; code: string; is_active: boolean };

/** Shown when the Money Routing default for a kind points at a switched-off
 *  account. Reception has no picker to route around it, so the fix is an admin's. */
export const INACTIVE_ROUTED_ACCOUNT_ERROR =
  "This payout is set to post to an account that has been switched off. Ask an admin to fix it in Money Routing, then try again.";

/**
 * Server-side twin of `effectiveCashAccountCode`: the same resolution, but over
 * rows that may be inactive, so it can also say whether the effective account
 * is switched off. The browser only receives ACTIVE accounts, so for an
 * inactive routed default it resolves nothing and shows no "Which lab?"
 * picker — the server must then answer with `INACTIVE_ROUTED_ACCOUNT_ERROR`,
 * not "Pick which lab you paid", which reception has no way to do.
 */
export function resolveCashAdjustmentAccount(
  contraAccountId: string | null | undefined,
  rule: CashRule | undefined,
  rows: readonly CashAccountRow[],
): { code: string | undefined; inactive: boolean } {
  const pick = (id: string) => {
    const row = rows.find((a) => a.id === id);
    return { code: row?.code, inactive: row ? !row.is_active : false };
  };
  if (contraAccountId) return pick(contraAccountId);
  if (!rule || rule.requires_user_choice) return { code: SUSPENSE_CODE, inactive: false };
  return pick(rule.account_id);
}
