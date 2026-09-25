import { describe, it, expect } from "vitest";
import { livePayments, statementSummary, visitMoneySummary, waivedAmount } from "./statement";

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
    expect(statementSummary(6438, [pay(3000), pay("1000.00")], { hmoBilled: false, waived: false })).toEqual({
      charges: 6438,
      paid: 4000,
      waived: 0,
      balance: 2438,
      balanceLabel: "Balance due",
    });
  });

  it("never counts a voided payment", () => {
    const s = statementSummary(1000, [pay(1000, "2026-09-24T01:00:00Z")], { hmoBilled: false, waived: false });
    expect(s.paid).toBe(0);
    expect(s.balanceLabel).toBe("Balance due");
  });

  it("is paid in full without float noise", () => {
    const s = statementSummary(0.3, [pay(0.1), pay(0.2)], { hmoBilled: false, waived: false });
    expect(s.balance).toBe(0);
    expect(s.balanceLabel).toBe("Paid in full");
  });

  it("says overpaid rather than a negative balance due", () => {
    const s = statementSummary(500, [pay(600)], { hmoBilled: false, waived: false });
    expect(s.balance).toBe(-100);
    expect(s.balanceLabel).toBe("Overpaid");
  });

  it("does not call an HMO visit's open balance 'due'", () => {
    expect(statementSummary(2000, [], { hmoBilled: true, waived: false }).balanceLabel).toBe("Balance");
  });

  it("has nothing to pay on a ₱0 bill", () => {
    expect(statementSummary(0, [], { hmoBilled: false, waived: false }).balanceLabel).toBe("Paid in full");
  });

  it("shows a waived remainder as waived, with nothing due", () => {
    // ₱1,000 visit, ₱400 paid, the rest waived (charity / no-charge).
    expect(statementSummary(1000, [pay(400)], { hmoBilled: false, waived: true })).toEqual({
      charges: 1000,
      paid: 400,
      waived: 600,
      balance: 0,
      balanceLabel: "Nothing due",
    });
  });

  it("does not invent a waiver on a visit that was paid in full before being waived", () => {
    const s = statementSummary(1000, [pay(1000)], { hmoBilled: false, waived: true });
    expect(s.waived).toBe(0);
    expect(s.balanceLabel).toBe("Paid in full");
  });

  it("still says overpaid on a waived visit that took too much", () => {
    const s = statementSummary(1000, [pay(1200)], { hmoBilled: false, waived: true });
    expect(s.waived).toBe(0);
    expect(s.balanceLabel).toBe("Overpaid");
  });
});

// The list pages (Reception Queue, patient Visits, the portal's "Your visits")
// read the visit row, not its payments. Same rule as the statement.
const visit = (
  payment_status: string,
  total_php: number | string,
  paid_php: number | string,
  hmo_provider_id: string | null = null,
) => ({ payment_status, total_php, paid_php, hmo_provider_id });

describe("visitMoneySummary", () => {
  it("reads a waived remainder as nothing due", () => {
    expect(visitMoneySummary(visit("waived", "1500.00", "200.00"))).toEqual({
      charges: 1500,
      paid: 200,
      waived: 1300,
      balance: 0,
      balanceLabel: "Nothing due",
    });
  });

  it("owes the remainder on a part-paid visit", () => {
    const s = visitMoneySummary(visit("partial", 1500, 200));
    expect(s.balance).toBe(1300);
    expect(s.balanceLabel).toBe("Balance due");
  });

  it("labels an HMO visit's open share Balance, not Balance due", () => {
    expect(visitMoneySummary(visit("unpaid", 1500, 0, "hmo-1")).balanceLabel).toBe("Balance");
  });

  it("is paid in full when paid equals the total", () => {
    expect(visitMoneySummary(visit("paid", "0.30", 0.3)).balanceLabel).toBe("Paid in full");
  });
});

describe("waivedAmount", () => {
  it("is the unpaid remainder of a waived visit", () => {
    expect(waivedAmount(visit("waived", 1500, 200))).toBe(1300);
  });

  it("is zero unless the visit is waived", () => {
    expect(waivedAmount(visit("partial", 1500, 200))).toBe(0);
    expect(waivedAmount(visit("unpaid", 1500, 0, "hmo-1"))).toBe(0);
  });

  it("is zero for a waived visit that was paid in full or over", () => {
    expect(waivedAmount(visit("waived", 1500, 1500))).toBe(0);
    expect(waivedAmount(visit("waived", 1500, 1600))).toBe(0);
  });

  it("does not leave float noise in centavos", () => {
    expect(waivedAmount(visit("waived", "0.30", "0.10"))).toBe(0.2);
  });
});
