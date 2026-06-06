// Pure monthly P&L rollup for the Operations Trends chart (first B2 chart).
// NO "server-only" import — vitest-tested + consumed by the Trends Server Component.
import { num } from "./daily-report";

export interface MonthlyPnlRow {
  month: string; // "YYYY-MM" sort key
  label: string; // "Dec 2023" display
  grossProfit: number;
  expenses: number;
  net: number;
}

interface DatedNet {
  business_date: string | null;
  net: number | string | null;
}
interface DatedExpense {
  business_date: string | null;
  expense_php: number | string | null;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

export function buildMonthlyPnl(
  totalsRows: DatedNet[],
  expenseRows: DatedExpense[],
): MonthlyPnlRow[] {
  const byMonth = new Map<string, { grossProfit: number; expenses: number }>();
  const ensure = (month: string) => {
    let row = byMonth.get(month);
    if (!row) {
      row = { grossProfit: 0, expenses: 0 };
      byMonth.set(month, row);
    }
    return row;
  };

  for (const r of totalsRows) {
    if (!r.business_date) continue;
    ensure(r.business_date.slice(0, 7)).grossProfit += num(r.net);
  }
  for (const r of expenseRows) {
    if (!r.business_date) continue;
    ensure(r.business_date.slice(0, 7)).expenses += num(r.expense_php);
  }

  return [...byMonth.keys()].sort().map((month) => {
    const { grossProfit, expenses } = byMonth.get(month)!;
    return { month, label: monthLabel(month), grossProfit, expenses, net: grossProfit - expenses };
  });
}
