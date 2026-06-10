import { describe, it, expect } from "vitest";
import { buildHmoArMatrix, type HmoArRow } from "./hmo-ar-report";

const range = { from: "2024-02-01", to: "2024-02-29" };

describe("buildHmoArMatrix", () => {
  it("carries the opening balance from movement before the visible range", () => {
    const rows: HmoArRow[] = [
      // pre-range: billed 1000 in Jan, none paid -> opening balance 1000
      { business_date: "2024-01-10", provider_name: "Maxicare", source: "historic", billed_in_php: 1000, paid_out_php: 0 },
      // in range: bill 500 on Feb 5, pay 300 on Feb 20
      { business_date: "2024-02-05", provider_name: "Maxicare", source: "historic", billed_in_php: 500, paid_out_php: 0 },
      { business_date: "2024-02-20", provider_name: "Maxicare", source: "historic", billed_in_php: 0, paid_out_php: 300 },
    ];
    const m = buildHmoArMatrix(rows, range);
    const max = m.providers.find((p) => p.provider === "Maxicare")!;
    expect(max.byDay["2024-02-05"]).toEqual({ billedIn: 500, paidOut: 0, ending: 1500 });
    expect(max.byDay["2024-02-20"]).toEqual({ billedIn: 0, paidOut: 300, ending: 1200 });
    expect(max.endingBalance).toBe(1200);
    expect(max.rangeBilledIn).toBe(500);
    expect(max.rangePaidOut).toBe(300);
  });

  it("sums live + historic on the same day", () => {
    const rows: HmoArRow[] = [
      { business_date: "2024-02-05", provider_name: "Etiqa", source: "historic", billed_in_php: 100, paid_out_php: 0 },
      { business_date: "2024-02-05", provider_name: "Etiqa", source: "live", billed_in_php: 50, paid_out_php: 0 },
    ];
    const m = buildHmoArMatrix(rows, range);
    expect(m.providers[0].byDay["2024-02-05"].billedIn).toBe(150);
  });

  it("forces (unknown HMO) last and sorts the rest by ending desc", () => {
    const rows: HmoArRow[] = [
      { business_date: "2024-02-01", provider_name: "(unknown HMO)", source: "historic", billed_in_php: 9999, paid_out_php: 0 },
      { business_date: "2024-02-01", provider_name: "Small", source: "historic", billed_in_php: 10, paid_out_php: 0 },
      { business_date: "2024-02-01", provider_name: "Big", source: "historic", billed_in_php: 5000, paid_out_php: 0 },
    ];
    const m = buildHmoArMatrix(rows, range);
    expect(m.providers.map((p) => p.provider)).toEqual(["Big", "Small", "(unknown HMO)"]);
  });

  it("computes a TOTAL row across providers per column and overall", () => {
    const rows: HmoArRow[] = [
      { business_date: "2024-02-10", provider_name: "A", source: "historic", billed_in_php: 200, paid_out_php: 0 },
      { business_date: "2024-02-10", provider_name: "B", source: "historic", billed_in_php: 300, paid_out_php: 0 },
    ];
    const m = buildHmoArMatrix(rows, range);
    expect(m.total.provider).toBe("TOTAL");
    expect(m.total.byDay["2024-02-10"].ending).toBe(500);
    expect(m.total.endingBalance).toBe(500);
  });

  it("ignores movement after the range end", () => {
    const rows: HmoArRow[] = [
      { business_date: "2024-02-10", provider_name: "A", source: "historic", billed_in_php: 200, paid_out_php: 0 },
      { business_date: "2024-03-10", provider_name: "A", source: "historic", billed_in_php: 999, paid_out_php: 0 },
    ];
    const m = buildHmoArMatrix(rows, range);
    expect(m.providers[0].endingBalance).toBe(200);
  });
});
