import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchAllRows } from "@/lib/reports/paging";
import { LEDGER_TOTAL_STATUSES } from "./ledger-status";

export interface IncomeStatementLine {
  debit_php: number;
  credit_php: number;
  journal_entries: { posting_date: string; status: string } | null;
  chart_of_accounts: { id: string; code: string; name: string; type: string; normal_balance: string } | null;
}

/** One definition of accrual P&L for the statement and its dashboard tile. */
export async function loadIncomeStatementLines(client: SupabaseClient<Database>, start: string, end: string) {
  const { rows, truncated } = await fetchAllRows<IncomeStatementLine>((from, to) =>
    client.from("journal_lines")
      .select("debit_php, credit_php, journal_entries!inner ( posting_date, status ), chart_of_accounts!inner ( id, code, name, type, normal_balance )")
      .in("journal_entries.status", LEDGER_TOTAL_STATUSES)
      .gte("journal_entries.posting_date", start)
      .lte("journal_entries.posting_date", end)
      .in("chart_of_accounts.type", ["revenue", "contra_revenue", "expense"])
      .order("id", { ascending: true })
      .range(from, to)
      .returns<IncomeStatementLine[]>(),
    200_000,
  );
  // The former statement pager had this ceiling too, but silently returned a
  // partial total. Neither a statement nor a tile may present that as income.
  if (truncated) throw new Error("Income statement exceeds 200,000 lines; narrow the period.");
  return rows;
}

export function balanceFor(row: { debit_php: number; credit_php: number }, normalBalance: string): number {
  const debit = Number(row.debit_php ?? 0), credit = Number(row.credit_php ?? 0);
  return normalBalance === "credit" ? credit - debit : debit - credit;
}

export function incomeStatementTotals(lines: readonly IncomeStatementLine[]) {
  let revenue = 0, contraRevenue = 0, expense = 0;
  for (const row of lines) {
    const account = row.chart_of_accounts;
    if (!account) continue;
    const amount = balanceFor(row, account.normal_balance);
    if (account.type === "revenue") revenue += amount;
    else if (account.type === "contra_revenue") contraRevenue += amount;
    else if (account.type === "expense") expense += amount;
  }
  return { revenue, contraRevenue, expense, netRevenue: revenue - contraRevenue, netIncome: revenue - contraRevenue - expense };
}
