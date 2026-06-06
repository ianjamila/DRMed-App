import { describe, it, expect } from "vitest";
import { buildMonthlyPnl } from "./trends";

describe("buildMonthlyPnl", () => {
  it("rolls daily rows up into months: net = grossProfit − expenses", () => {
    const totals = [
      { business_date: "2023-12-01", net: 5000 },
      { business_date: "2023-12-15", net: 3000 },
      { business_date: "2024-01-10", net: 2000 },
    ];
    const expenses = [
      { business_date: "2023-12-02", expense_php: 1000 },
      { business_date: "2024-01-05", expense_php: 800 },
    ];
    const out = buildMonthlyPnl(totals, expenses);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ month: "2023-12", label: "Dec 2023", grossProfit: 8000, expenses: 1000, net: 7000 });
    expect(out[1]).toEqual({ month: "2024-01", label: "Jan 2024", grossProfit: 2000, expenses: 800, net: 1200 });
  });

  it("sorts months chronologically regardless of input order", () => {
    const out = buildMonthlyPnl(
      [{ business_date: "2024-03-01", net: 1 }, { business_date: "2024-01-01", net: 1 }],
      [],
    );
    expect(out.map((r) => r.month)).toEqual(["2024-01", "2024-03"]);
  });

  it("skips rows with a null business_date", () => {
    const out = buildMonthlyPnl(
      [{ business_date: null, net: 999 }, { business_date: "2024-02-01", net: 10 }],
      [{ business_date: null, expense_php: 999 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].grossProfit).toBe(10);
    expect(out[0].expenses).toBe(0);
  });

  it("returns [] for empty input", () => {
    expect(buildMonthlyPnl([], [])).toEqual([]);
  });
});
