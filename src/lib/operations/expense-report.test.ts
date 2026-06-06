import { describe, it, expect } from "vitest";
import {
  EXPENSE_LINES,
  CATEGORY_ORDER,
  buildExpenseMatrix,
  type ExpenseAccountRow,
} from "./expense-report";

const days = ["2026-01-01", "2026-01-02"];

describe("EXPENSE_LINES config", () => {
  it("has all 17 sheet lines in 4 categories", () => {
    expect(EXPENSE_LINES).toHaveLength(17);
    expect(CATEGORY_ORDER).toEqual([
      "Manpower",
      "Rent & Utilities",
      "Supplies & Equipment",
      "Etc",
    ]);
    const benefits = EXPENSE_LINES.find((l) => l.label === "Benefits");
    expect(benefits?.codes).toEqual(["6120", "6121", "6122", "6123", "6124"]);
  });
});

describe("buildExpenseMatrix", () => {
  const rows: ExpenseAccountRow[] = [
    { business_date: "2026-01-01", code: "6100", name: "Salaries & Wages", expense_php: 700 },
    { business_date: "2026-01-01", code: "6120", name: "Benefits", expense_php: 50 },
    { business_date: "2026-01-01", code: "6121", name: "Employer SSS", expense_php: 30 },
    { business_date: "2026-01-02", code: "6410", name: "Lab Supplies", expense_php: 200 },
  ];

  it("groups lines into categories with subtotals", () => {
    const m = buildExpenseMatrix(rows, days);
    const manpower = m.categories.find((c) => c.name === "Manpower")!;
    const salaries = manpower.lines.find((l) => l.label === "Salaries & Wages")!;
    expect(salaries.byDay["2026-01-01"]).toBe(700);
    const benefits = manpower.lines.find((l) => l.label === "Benefits")!;
    // 6120 + 6121 aggregate into the single Benefits line
    expect(benefits.byDay["2026-01-01"]).toBe(80);
    expect(manpower.subtotal.byDay["2026-01-01"]).toBe(780);
    expect(manpower.subtotal.kind).toBe("subtotal");
  });

  it("TOTAL equals the sum of all lines + other (books-tie invariant)", () => {
    const m = buildExpenseMatrix(rows, days);
    expect(m.total.byDay["2026-01-01"]).toBe(780);
    expect(m.total.byDay["2026-01-02"]).toBe(200);
    expect(m.total.total).toBe(980);
    expect(m.total.kind).toBe("total");
  });

  it("routes unmapped expense codes into a non-zero Other line", () => {
    const withOther: ExpenseAccountRow[] = [
      ...rows,
      { business_date: "2026-01-02", code: "7100", name: "Interest Expense", expense_php: 15 },
    ];
    const m = buildExpenseMatrix(withOther, days);
    expect(m.other).not.toBeNull();
    expect(m.other!.byDay["2026-01-02"]).toBe(15);
    expect(m.total.total).toBe(995); // 980 + 15
  });

  it("omits the Other line when all codes are mapped", () => {
    const m = buildExpenseMatrix(rows, days);
    expect(m.other).toBeNull();
  });
});

import {
  buildNetIncome,
  buildCashFlow,
  largestCategory,
  cashFlowEnding,
  booksNetIncome,
  type PnlRow,
} from "./expense-report";

describe("buildNetIncome", () => {
  it("net = gross profit − total expenses, per day and total", () => {
    const days2 = ["2026-01-01", "2026-01-02"];
    const gross = { "2026-01-01": 8660, "2026-01-02": 1000 };
    const exp = { "2026-01-01": 6760, "2026-01-02": 400 };
    const ni = buildNetIncome(gross, exp, days2);
    expect(ni.net["2026-01-01"]).toBe(1900);
    expect(ni.net["2026-01-02"]).toBe(600);
    expect(ni.totalNet).toBe(2500);
    expect(ni.totalGrossProfit).toBe(9660);
    expect(ni.totalExpenses).toBe(7160);
  });
});

describe("buildCashFlow", () => {
  it("runs the balance from 0: ending = starting + collected − expenses", () => {
    const days2 = ["2026-01-01", "2026-01-02", "2026-01-03"];
    const collected = { "2026-01-01": 7960, "2026-01-02": 1500, "2026-01-03": 2100 };
    const exp = { "2026-01-01": 6760, "2026-01-02": 750, "2026-01-03": 1400 };
    const cf = buildCashFlow(collected, exp, days2);
    expect(cf.starting.byDay["2026-01-01"]).toBe(0);
    expect(cf.ending.byDay["2026-01-01"]).toBe(1200);
    expect(cf.starting.byDay["2026-01-02"]).toBe(1200);
    expect(cf.ending.byDay["2026-01-02"]).toBe(1950);
    expect(cf.ending.byDay["2026-01-03"]).toBe(2650);
  });
});

describe("largestCategory / cashFlowEnding / booksNetIncome", () => {
  it("largestCategory returns the category with the biggest subtotal", () => {
    const m = buildExpenseMatrix(
      [
        { business_date: "2026-01-01", code: "6100", name: "Salaries", expense_php: 700 },
        { business_date: "2026-01-01", code: "6410", name: "Lab Supplies", expense_php: 200 },
      ],
      ["2026-01-01"],
    );
    expect(largestCategory(m)?.name).toBe("Manpower");
    expect(largestCategory(m)?.total).toBe(700);
  });

  it("cashFlowEnding is the last day's running balance", () => {
    const days2 = ["2026-01-01", "2026-01-02"];
    const cf = buildCashFlow({ "2026-01-01": 100, "2026-01-02": 50 }, { "2026-01-01": 30, "2026-01-02": 10 }, days2);
    expect(cashFlowEnding(cf)).toBe(110); // (100-30) + (50-10)
  });

  it("booksNetIncome = Σ(revenue − contra − expense)", () => {
    const rows: PnlRow[] = [
      { business_date: "2026-01-01", revenue_php: 8700, contra_revenue_php: 100, expense_php: 6760 },
      { business_date: "2026-01-02", revenue_php: 1000, contra_revenue_php: 0, expense_php: 400 },
    ];
    expect(booksNetIncome(rows)).toBe(2440); // (8700-100-6760)+(1000-0-400)
  });
});
