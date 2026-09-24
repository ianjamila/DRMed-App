/**
 * Chart-of-accounts pickers grouped by account type. The accrual-template line
 * editor grouped its account dropdown this way first; the Chart of Accounts
 * "Parent account" picker now shares it, so a bookkeeper choosing a parent sees
 * Assets / Liabilities / … instead of one flat list of every account.
 *
 * Pure logic (no `server-only`, no DB) so the client forms and the server
 * actions import the same rules.
 */

import { humaniseCode } from "@/lib/format/humanise-code";

/** The order a chart of accounts is read in — by code range, not A–Z. */
export const ACCOUNT_TYPE_ORDER = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "contra_revenue",
  "expense",
  "contra_expense",
  "memo",
] as const;

export function accountTypeGroupLabel(type: string): string {
  switch (type) {
    case "asset":
      return "Assets (1xxx)";
    case "liability":
      return "Liabilities (2xxx)";
    case "equity":
      return "Equity (3xxx)";
    case "revenue":
      return "Revenue (4xxx)";
    case "contra_revenue":
      return "Contra revenue (49xx)";
    case "expense":
      return "Expenses (5xxx-7xxx)";
    case "contra_expense":
      return "Contra expense";
    case "memo":
      return "Memo / suspense";
    default:
      return humaniseCode(type);
  }
}

export interface AccountGroup<T> {
  type: string;
  label: string;
  accounts: T[];
}

/** Non-empty groups in chart order (unknown types last), each sorted by code. */
export function groupAccountsByType<T extends { code: string; type: string }>(
  accounts: readonly T[],
): AccountGroup<T>[] {
  const byType = new Map<string, T[]>();
  for (const a of accounts) {
    const list = byType.get(a.type) ?? [];
    list.push(a);
    byType.set(a.type, list);
  }
  const known: readonly string[] = ACCOUNT_TYPE_ORDER;
  const types = [
    ...known.filter((t) => byType.has(t)),
    ...[...byType.keys()].filter((t) => !known.includes(t)).sort(),
  ];
  return types.map((type) => ({
    type,
    label: accountTypeGroupLabel(type),
    accounts: [...byType.get(type)!].sort((a, b) => a.code.localeCompare(b.code)),
  }));
}

/**
 * Why a parent account can't be used, or null when it can. The form used to
 * only hint "Must be the same type" under a flat list of every account; this
 * is the rule both the form and the server actions now apply.
 */
export function parentAccountError(
  account: { id?: string; type: string },
  parent: { id: string; type: string } | null,
): string | null {
  if (!parent) return null;
  if (account.id && parent.id === account.id) return "An account can't be its own parent.";
  if (parent.type !== account.type) {
    return `The parent account must be the same type — this account is ${accountTypeGroupLabel(account.type)} and the parent is ${accountTypeGroupLabel(parent.type)}.`;
  }
  return null;
}
