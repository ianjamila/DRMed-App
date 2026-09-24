import { describe, expect, it } from "vitest";
import {
  buildSpendMatrix,
  buildSummary,
  computeLabShares,
  enumerateMonths,
  fillMonthlyMargin,
  formatTurnaroundHours,
  marginPct,
  NOT_TAGGED_LABEL,
  sortTurnaroundRows,
  withinPromisePct,
  type MonthlyMarginRow,
  type SpendByLabRow,
  type TurnaroundRow,
} from "./send-out-labs";

describe("enumerateMonths", () => {
  it("lists every month between start and end, newest first, inclusive", () => {
    expect(enumerateMonths("2026-06-15", "2026-09-01")).toEqual([
      "2026-09-01",
      "2026-08-01",
      "2026-07-01",
      "2026-06-01",
    ]);
  });

  it("handles a single month", () => {
    expect(enumerateMonths("2026-09-01", "2026-09-30")).toEqual(["2026-09-01"]);
  });

  it("wraps across a year boundary", () => {
    expect(enumerateMonths("2025-11-05", "2026-02-20")).toEqual([
      "2026-02-01",
      "2026-01-01",
      "2025-12-01",
      "2025-11-01",
    ]);
  });

  it("matches the '12 months inclusive of current month' default window", () => {
    // Same formula as buildPeriodPresets' "12m" preset.
    expect(enumerateMonths("2025-10-01", "2026-09-24")).toHaveLength(12);
  });
});

describe("buildSpendMatrix", () => {
  const months = ["2026-09-01", "2026-08-01"];
  const rows: SpendByLabRow[] = [
    { month: "2026-09-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 10000, entries: 2 },
    { month: "2026-09-01", vendor_id: "mm", vendor_name: "Micromedic", spend_php: 4000, entries: 1 },
    { month: "2026-08-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 6000, entries: 1 },
    { month: "2026-08-01", vendor_id: null, vendor_name: null, spend_php: 1500, entries: 1 },
  ];

  it("orders columns by spend descending, Not tagged always last", () => {
    const matrix = buildSpendMatrix(rows, months);
    expect(matrix.columns.map((c) => c.label)).toEqual(["Hi Precision", "Micromedic", NOT_TAGGED_LABEL]);
  });

  it("fills a month with no rows as zero rather than dropping it", () => {
    const matrix = buildSpendMatrix(rows, ["2026-09-01", "2026-07-01"]);
    const july = matrix.rows.find((r) => r.month === "2026-07-01")!;
    expect(july.totalPhp).toBe(0);
    for (const col of matrix.columns) expect(july.byLab[col.key]).toBe(0);
  });

  it("always includes a Not tagged column even with zero untagged spend", () => {
    const matrix = buildSpendMatrix(
      [{ month: "2026-09-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 100, entries: 1 }],
      ["2026-09-01"],
    );
    expect(matrix.columns.map((c) => c.label)).toContain(NOT_TAGGED_LABEL);
  });

  it("totals row sums every month per lab and grand total", () => {
    const matrix = buildSpendMatrix(rows, months);
    const hp = matrix.columns.find((c) => c.label === "Hi Precision")!;
    expect(matrix.totals.byLab[hp.key]).toBe(16000);
    expect(matrix.totals.totalPhp).toBe(21500);
  });

  it("row totals equal the sum of that row's lab columns", () => {
    const matrix = buildSpendMatrix(rows, months);
    for (const row of matrix.rows) {
      const sum = matrix.columns.reduce((s, c) => s + row.byLab[c.key], 0);
      expect(row.totalPhp).toBe(sum);
    }
  });
});

describe("computeLabShares", () => {
  it("computes each lab's percent share of total spend", () => {
    const shares = computeLabShares([
      { month: "2026-09-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 75, entries: 1 },
      { month: "2026-09-01", vendor_id: "mm", vendor_name: "Micromedic", spend_php: 25, entries: 1 },
    ]);
    expect(shares).toEqual([
      { vendorId: "hp", label: "Hi Precision", spendPhp: 75, sharePct: 75 },
      { vendorId: "mm", label: "Micromedic", spendPhp: 25, sharePct: 25 },
    ]);
  });

  it("is 0% per lab, not NaN, when there is no spend at all", () => {
    expect(computeLabShares([])).toEqual([]);
    const shares = computeLabShares([
      { month: "2026-09-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 0, entries: 0 },
    ]);
    expect(shares[0].sharePct).toBe(0);
  });
});

describe("buildSummary", () => {
  it("computes total spend, tests, billed and margin", () => {
    const spendRows: SpendByLabRow[] = [
      { month: "2026-09-01", vendor_id: "hp", vendor_name: "Hi Precision", spend_php: 10000, entries: 2 },
      { month: "2026-09-01", vendor_id: null, vendor_name: null, spend_php: 2000, entries: 1 },
    ];
    const marginRows: MonthlyMarginRow[] = [
      { month: "2026-09-01", tests: 5, revenue_php: 15000, spend_php: 12000, margin_php: 3000 },
    ];
    const summary = buildSummary(spendRows, marginRows);
    expect(summary.totalSpendPhp).toBe(12000);
    expect(summary.testsBilled).toBe(5);
    expect(summary.billedPhp).toBe(15000);
    expect(summary.marginPhp).toBe(3000);
    expect(summary.labShares.map((s) => s.label)).toEqual(["Hi Precision", "Not tagged"]);
  });

  it("is all zero with no rows, not NaN", () => {
    const summary = buildSummary([], []);
    expect(summary).toEqual({
      totalSpendPhp: 0,
      testsBilled: 0,
      billedPhp: 0,
      marginPhp: 0,
      labShares: [],
    });
  });
});

describe("fillMonthlyMargin", () => {
  it("fills a missing month with zeros, preserving the given month order", () => {
    const rows: MonthlyMarginRow[] = [
      { month: "2026-09-01", tests: 3, revenue_php: 9000, spend_php: 6000, margin_php: 3000 },
    ];
    const filled = fillMonthlyMargin(rows, ["2026-09-01", "2026-08-01"]);
    expect(filled).toEqual([
      { month: "2026-09-01", tests: 3, revenue_php: 9000, spend_php: 6000, margin_php: 3000 },
      { month: "2026-08-01", tests: 0, revenue_php: 0, spend_php: 0, margin_php: 0 },
    ]);
  });
});

describe("marginPct", () => {
  it("computes margin as a percent of revenue", () => {
    expect(marginPct(200, 50)).toBe(25);
  });

  it("is null (not Infinity/NaN) with zero revenue", () => {
    expect(marginPct(0, 0)).toBeNull();
    expect(marginPct(0, -100)).toBeNull();
  });
});

describe("sortTurnaroundRows", () => {
  it("orders by most tests first, tie-broken by lab name", () => {
    const rows: TurnaroundRow[] = [
      { vendor_id: "mm", lab_name: "Micromedic", tests: 4, avg_hours: 10, median_hours: 10, p90_hours: 20, with_promise: 4, within_promise: 4 },
      { vendor_id: "hp", lab_name: "Hi Precision", tests: 10, avg_hours: 10, median_hours: 10, p90_hours: 20, with_promise: 10, within_promise: 8 },
      { vendor_id: null, lab_name: "Not set", tests: 4, avg_hours: 10, median_hours: 10, p90_hours: 20, with_promise: 0, within_promise: 0 },
    ];
    expect(sortTurnaroundRows(rows).map((r) => r.lab_name)).toEqual(["Hi Precision", "Micromedic", "Not set"]);
  });
});

describe("formatTurnaroundHours", () => {
  it("shows hours with one decimal under 48 hours", () => {
    expect(formatTurnaroundHours(6)).toBe("6.0 hrs");
    expect(formatTurnaroundHours(47.9)).toBe("47.9 hrs");
  });

  it("switches to days at 48 hours and above", () => {
    expect(formatTurnaroundHours(48)).toBe("2.0 days");
    expect(formatTurnaroundHours(76)).toBe("3.2 days");
  });

  it("is an em dash for null/undefined/NaN", () => {
    expect(formatTurnaroundHours(null)).toBe("—");
    expect(formatTurnaroundHours(undefined)).toBe("—");
    expect(formatTurnaroundHours(NaN)).toBe("—");
  });
});

describe("withinPromisePct", () => {
  it("rounds to a whole-number percent", () => {
    expect(withinPromisePct(3, 2)).toBe("67%");
  });

  it("is an em dash when nothing carried a promised turnaround", () => {
    expect(withinPromisePct(0, 0)).toBe("—");
  });
});
