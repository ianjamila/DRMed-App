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
