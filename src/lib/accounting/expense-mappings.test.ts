import { describe, it, expect } from "vitest";
import {
  CATEGORY_TO_COA,
  MOP_OPTIONS,
  MOP_TO_COA,
  PETTY_CASH_CATEGORIES,
  PETTY_CASH_CATEGORY_OPTIONS,
  PETTY_CASH_COA_TO_CATEGORY,
  TILL_CASH_MOP,
  isTillCashMop,
  type Mop,
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

describe("till cash is the one MOP that must go through the drawer", () => {
  it("TILL_CASH_MOP is the MOP that credits Cash on Hand (1010)", () => {
    expect(MOP_TO_COA[TILL_CASH_MOP]).toBe("1010");
  });

  it("is the ONLY MOP mapped to 1010 — any other would need the same treatment", () => {
    const creditsTheTill = (Object.keys(MOP_TO_COA) as Mop[]).filter(
      (m) => MOP_TO_COA[m] === "1010",
    );
    expect(creditsTheTill).toEqual([TILL_CASH_MOP]);
  });

  it("isTillCashMop flags Clinic Cash and nothing else", () => {
    for (const m of Object.keys(MOP_TO_COA) as Mop[]) {
      expect(isTillCashMop(m), `${m}`).toBe(m === TILL_CASH_MOP);
    }
  });

  it("stays offered in the Quick expense picker (it routes, it isn't removed)", () => {
    expect(MOP_OPTIONS.map((o) => o.value)).toContain(TILL_CASH_MOP);
  });
});

describe("petty-cash contra account ↔ category round-trip", () => {
  it("maps every petty-cash category's account back to that category", () => {
    for (const c of PETTY_CASH_CATEGORIES) {
      expect(PETTY_CASH_COA_TO_CATEGORY[CATEGORY_TO_COA[c]]).toBe(c);
    }
  });

  it("is injective over the subset — no two categories share an account", () => {
    const codes = PETTY_CASH_CATEGORIES.map((c) => CATEGORY_TO_COA[c]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(PETTY_CASH_COA_TO_CATEGORY)).toHaveLength(
      PETTY_CASH_CATEGORIES.length,
    );
  });

  it("does not claim accounts outside the subset (6120 is ambiguous, 9999 is suspense)", () => {
    expect(PETTY_CASH_COA_TO_CATEGORY["6120"]).toBeUndefined();
    expect(PETTY_CASH_COA_TO_CATEGORY["9999"]).toBeUndefined();
    expect(PETTY_CASH_COA_TO_CATEGORY["1010"]).toBeUndefined();
  });
});
