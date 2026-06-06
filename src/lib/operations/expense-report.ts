// Pure pivot + config for the Operations Expenses & P&L report (B1.3).
// NO "server-only" import — vitest-tested + shared with the CSV route.
import { num } from "./daily-report";

export interface ExpenseAccountRow {
  business_date: string;
  code: string;
  name: string;
  expense_php: string | number | null;
}

export type ExpenseCategory =
  | "Manpower"
  | "Rent & Utilities"
  | "Supplies & Equipment"
  | "Etc";

export const CATEGORY_ORDER: ExpenseCategory[] = [
  "Manpower",
  "Rent & Utilities",
  "Supplies & Equipment",
  "Etc",
];

export interface ExpenseLineDef {
  category: ExpenseCategory;
  label: string;
  codes: string[];
}

// The 17 manual-sheet lines (rows 70–86) → GL account code(s).
export const EXPENSE_LINES: ExpenseLineDef[] = [
  { category: "Manpower", label: "Salaries & Wages", codes: ["6100"] },
  { category: "Manpower", label: "Doctors Payroll", codes: ["6110"] },
  // Benefits aggregates the base account + payroll employer-contribution sub-accounts.
  { category: "Manpower", label: "Benefits", codes: ["6120", "6121", "6122", "6123", "6124"] },
  { category: "Rent & Utilities", label: "Rent", codes: ["6200"] },
  { category: "Rent & Utilities", label: "Utilities", codes: ["6210"] },
  { category: "Rent & Utilities", label: "Telecommunication / Internet", codes: ["6220"] },
  { category: "Supplies & Equipment", label: "Depreciation & Amortization", codes: ["6300"] },
  { category: "Supplies & Equipment", label: "Maintenance & Repair", codes: ["6310"] },
  { category: "Supplies & Equipment", label: "Office Supplies", codes: ["6400"] },
  { category: "Supplies & Equipment", label: "Lab Supplies", codes: ["6410"] },
  { category: "Etc", label: "Send Out", codes: ["6420"] },
  { category: "Etc", label: "Marketing: Ads & Promotion", codes: ["6500"] },
  { category: "Etc", label: "Permits", codes: ["6600"] },
  { category: "Etc", label: "Legal & Regulatory", codes: ["6610"] },
  { category: "Etc", label: "Insurance", codes: ["6620"] },
  { category: "Etc", label: "Travel", codes: ["6700"] },
  { category: "Etc", label: "APE", codes: ["6710"] },
];

export type ExpenseRowKind = "line" | "subtotal" | "other" | "total";

export interface ExpenseMatrixRow {
  label: string;
  kind: ExpenseRowKind;
  byDay: Record<string, number>;
  total: number;
}

export interface ExpenseCategoryGroup {
  name: ExpenseCategory;
  lines: ExpenseMatrixRow[];
  subtotal: ExpenseMatrixRow;
}

export interface ExpenseMatrix {
  days: string[];
  categories: ExpenseCategoryGroup[];
  other: ExpenseMatrixRow | null; // only when non-zero
  total: ExpenseMatrixRow;
}

function emptyRow(label: string, kind: ExpenseRowKind, days: string[]): ExpenseMatrixRow {
  const byDay: Record<string, number> = {};
  for (const d of days) byDay[d] = 0;
  return { label, kind, byDay, total: 0 };
}

function addTo(row: ExpenseMatrixRow, day: string, value: number): void {
  if (!(day in row.byDay)) return;
  row.byDay[day] += value;
  row.total += value;
}

export function buildExpenseMatrix(
  rows: ExpenseAccountRow[],
  days: string[],
): ExpenseMatrix {
  const daySet = new Set(days);

  // code → line row (one row object shared by all of a line's codes, e.g. Benefits).
  const lineByCode = new Map<string, ExpenseMatrixRow>();
  const categories: ExpenseCategoryGroup[] = CATEGORY_ORDER.map((name) => {
    const lines = EXPENSE_LINES.filter((l) => l.category === name).map((def) => {
      const row = emptyRow(def.label, "line", days);
      for (const code of def.codes) lineByCode.set(code, row);
      return row;
    });
    return { name, lines, subtotal: emptyRow(`${name} subtotal`, "subtotal", days) };
  });

  const other = emptyRow("Other expenses", "other", days);
  const total = emptyRow("TOTAL EXPENSES", "total", days);

  for (const r of rows) {
    if (!daySet.has(r.business_date)) continue;
    const value = num(r.expense_php);
    const lineRow = lineByCode.get(r.code) ?? other;
    addTo(lineRow, r.business_date, value);
    addTo(total, r.business_date, value);
  }

  // Category subtotals = Σ their line rows per day.
  for (const cat of categories) {
    for (const line of cat.lines) {
      for (const d of days) addTo(cat.subtotal, d, line.byDay[d]);
    }
  }

  return { days, categories, other: other.total === 0 ? null : other, total };
}

export interface NetIncome {
  days: string[];
  grossProfit: Record<string, number>;
  expenses: Record<string, number>;
  net: Record<string, number>;
  totalGrossProfit: number;
  totalExpenses: number;
  totalNet: number;
}

export function buildNetIncome(
  grossProfitByDay: Record<string, number>,
  expensesByDay: Record<string, number>,
  days: string[],
): NetIncome {
  const grossProfit: Record<string, number> = {};
  const expenses: Record<string, number> = {};
  const net: Record<string, number> = {};
  let totalGrossProfit = 0;
  let totalExpenses = 0;
  for (const d of days) {
    const g = grossProfitByDay[d] ?? 0;
    const e = expensesByDay[d] ?? 0;
    grossProfit[d] = g;
    expenses[d] = e;
    net[d] = g - e;
    totalGrossProfit += g;
    totalExpenses += e;
  }
  return {
    days,
    grossProfit,
    expenses,
    net,
    totalGrossProfit,
    totalExpenses,
    totalNet: totalGrossProfit - totalExpenses,
  };
}

export interface CashFlowRow {
  label: string;
  byDay: Record<string, number>;
}
export interface CashFlow {
  days: string[];
  starting: CashFlowRow;
  collected: CashFlowRow;
  expenses: CashFlowRow;
  ending: CashFlowRow;
}

// Running operational roll anchored at 0 at the start of the range (the GL cash
// accounts can't anchor an absolute balance — see the spec).
export function buildCashFlow(
  collectedByDay: Record<string, number>,
  expensesByDay: Record<string, number>,
  days: string[],
): CashFlow {
  const starting: Record<string, number> = {};
  const collected: Record<string, number> = {};
  const expenses: Record<string, number> = {};
  const ending: Record<string, number> = {};
  let running = 0;
  for (const d of days) {
    const c = collectedByDay[d] ?? 0;
    const e = expensesByDay[d] ?? 0;
    starting[d] = running;
    collected[d] = c;
    expenses[d] = e;
    running = running + c - e;
    ending[d] = running;
  }
  return {
    days,
    starting: { label: "Starting balance", byDay: starting },
    collected: { label: "(+) Cash collected", byDay: collected },
    expenses: { label: "(−) Expenses", byDay: expenses },
    ending: { label: "(=) Ending balance", byDay: ending },
  };
}

export function largestCategory(
  matrix: ExpenseMatrix,
): { name: ExpenseCategory; total: number } | null {
  let best: { name: ExpenseCategory; total: number } | null = null;
  for (const cat of matrix.categories) {
    if (!best || cat.subtotal.total > best.total) {
      best = { name: cat.name, total: cat.subtotal.total };
    }
  }
  return best;
}

export function cashFlowEnding(cf: CashFlow): number {
  const last = cf.days[cf.days.length - 1];
  return last ? (cf.ending.byDay[last] ?? 0) : 0;
}

export interface PnlRow {
  business_date: string;
  revenue_php: string | number | null;
  contra_revenue_php: string | number | null;
  expense_php: string | number | null;
}

export function booksNetIncome(rows: PnlRow[]): number {
  return rows.reduce(
    (s, r) => s + num(r.revenue_php) - num(r.contra_revenue_php) - num(r.expense_php),
    0,
  );
}
