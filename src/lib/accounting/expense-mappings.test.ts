import { describe, it, expect } from "vitest";
import {
  CATEGORY_TO_COA,
  PETTY_CASH_CATEGORIES,
  PETTY_CASH_CATEGORY_OPTIONS,
} from "./expense-mappings";

describe("petty cash category subset", () => {
  it("every petty-cash category has a CoA mapping", () => {
    for (const c of PETTY_CASH_CATEGORIES) {
      expect(CATEGORY_TO_COA[c], `missing CoA for ${c}`).toBeTruthy();
    }
  });

  it("only books real 6xxx expense accounts (never the 9999 suspense)", () => {
    for (const c of PETTY_CASH_CATEGORIES) {
      const code = CATEGORY_TO_COA[c];
      expect(code, `${c} must map to a 6xxx account`).toMatch(/^6\d{3}$/);
      expect(code, `${c} must not hit the 9999 suspense`).not.toBe("9999");
    }
  });

  it("excludes 'Out of Pocket Expense' (the 9999 suspense category)", () => {
    expect(PETTY_CASH_CATEGORIES).not.toContain("Out of Pocket Expense");
    expect(CATEGORY_TO_COA["Out of Pocket Expense"]).toBe("9999");
  });

  it("excludes owner / payroll-level categories reception shouldn't book", () => {
    const forbidden = [
      "Salaries & Wages",
      "Doctors Payroll",
      "Benefits",
      "Past HMO of Doctors",
      "Rent",
      "Insurance",
      "Legal & Regulatory",
      "APE",
    ] as const;
    for (const c of forbidden) {
      expect(PETTY_CASH_CATEGORIES, `${c} must not be offered`).not.toContain(c);
    }
  });

  it("options list stays in sync with PETTY_CASH_CATEGORIES", () => {
    expect(PETTY_CASH_CATEGORY_OPTIONS.map((o) => o.value)).toEqual(
      PETTY_CASH_CATEGORIES,
    );
    for (const o of PETTY_CASH_CATEGORY_OPTIONS) {
      expect(o.hint.length, `${o.value} should have a plain hint`).toBeGreaterThan(0);
    }
  });
});
