import { describe, it, expect } from "vitest";
import { buildHmoArMatrix, type HmoArRow, summarizeAging, type AgingRow, AGING_BUCKETS } from "./hmo-ar-report";

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

describe("summarizeAging", () => {
  it("pivots rows into per-provider bucket columns sorted by total desc", () => {
    const rows: AgingRow[] = [
      { provider_name: "Maxicare", bucket: "0-30", total_php: 100, item_count: 1 },
      { provider_name: "Maxicare", bucket: "180+", total_php: 400, item_count: 2 },
      { provider_name: "Etiqa", bucket: "0-30", total_php: 50, item_count: 1 },
    ];
    const s = summarizeAging(rows);
    expect(s.providers.map((p) => p.provider)).toEqual(["Maxicare", "Etiqa"]);
    expect(s.providers[0].buckets["180+"]).toBe(400);
    expect(s.providers[0].total).toBe(500);
    expect(s.grandByBucket["0-30"]).toBe(150);
    expect(s.grandTotal).toBe(550);
  });

  it("defaults missing buckets to 0 across the canonical bucket set", () => {
    const rows: AgingRow[] = [{ provider_name: "iCare", bucket: "61-90", total_php: 30, item_count: 1 }];
    const s = summarizeAging(rows);
    for (const b of AGING_BUCKETS) expect(b in s.providers[0].buckets).toBe(true);
    expect(s.providers[0].buckets["0-30"]).toBe(0);
  });
});
