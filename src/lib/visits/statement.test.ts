import { describe, it, expect } from "vitest";
import { livePayments, statementSummary } from "./statement";

const pay = (amount_php: number | string, voided_at: string | null = null) => ({
  amount_php,
  voided_at,
});

describe("livePayments", () => {
  it("drops voided payments", () => {
    const ps = [pay(500), pay(200, "2026-09-24T01:00:00Z")];
    expect(livePayments(ps)).toEqual([ps[0]]);
  });
});

describe("statementSummary", () => {
  it("owes the remainder after partial payment", () => {
    expect(statementSummary(6438, [pay(3000), pay("1000.00")], { hmoBilled: false })).toEqual({
      charges: 6438,
      paid: 4000,
      balance: 2438,
      balanceLabel: "Balance due",
    });
  });

  it("never counts a voided payment", () => {
    const s = statementSummary(1000, [pay(1000, "2026-09-24T01:00:00Z")], { hmoBilled: false });
    expect(s.paid).toBe(0);
    expect(s.balanceLabel).toBe("Balance due");
  });

  it("is paid in full without float noise", () => {
    const s = statementSummary(0.3, [pay(0.1), pay(0.2)], { hmoBilled: false });
    expect(s.balance).toBe(0);
    expect(s.balanceLabel).toBe("Paid in full");
  });

  it("says overpaid rather than a negative balance due", () => {
    const s = statementSummary(500, [pay(600)], { hmoBilled: false });
    expect(s.balance).toBe(-100);
    expect(s.balanceLabel).toBe("Overpaid");
  });

  it("does not call an HMO visit's open balance 'due'", () => {
    expect(statementSummary(2000, [], { hmoBilled: true }).balanceLabel).toBe("Balance");
  });

  it("has nothing to pay on a ₱0 bill", () => {
    expect(statementSummary(0, [], { hmoBilled: false }).balanceLabel).toBe("Paid in full");
  });
});
