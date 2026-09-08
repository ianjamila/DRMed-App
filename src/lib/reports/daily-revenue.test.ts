import { describe, expect, it } from "vitest";
import {
  DAILY_REVENUE_CSV_HEADER,
  dailyRevenueCsvFilename,
  dailyRevenueCsvHref,
  dailyRevenueCsvRows,
  groupByDate,
  parseDailyRevenueParams,
  type DailyRevenueRow,
} from "./daily-revenue";

const TODAY = "2026-09-08";

describe("parseDailyRevenueParams", () => {
  it("defaults to month-to-date", () => {
    expect(parseDailyRevenueParams({}, TODAY)).toEqual({ from: "2026-09-01", to: TODAY });
  });
  it("keeps valid ISO dates", () => {
    expect(parseDailyRevenueParams({ from: "2026-08-01", to: "2026-08-31" }, TODAY)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });
  it("falls back on garbage instead of passing it to the DB", () => {
    expect(parseDailyRevenueParams({ from: "08/01/2026", to: "x" }, TODAY)).toEqual({
      from: "2026-09-01",
      to: TODAY,
    });
  });
});

const rows: DailyRevenueRow[] = [
  { business_date: "2026-09-08", service_code: "CBC", service_name: "CBC", service_kind: "lab_test", revenue_php: 350, released_count: 2 },
  { business_date: "2026-09-08", service_code: "FBS", service_name: "FBS", service_kind: "lab_test", revenue_php: 120.5, released_count: 1 },
  { business_date: "2026-09-07", service_code: "CBC", service_name: "CBC", service_kind: "lab_test", revenue_php: null, released_count: null },
];

describe("groupByDate", () => {
  it("keeps insertion order per date", () => {
    const byDate = groupByDate(rows);
    expect([...byDate.keys()]).toEqual(["2026-09-08", "2026-09-07"]);
    expect(byDate.get("2026-09-08")?.map((r) => r.service_code)).toEqual(["CBC", "FBS"]);
  });
});

describe("dailyRevenueCsvRows", () => {
  it("emits the header then one row per service-day with two-decimal pesos", () => {
    const out = dailyRevenueCsvRows(rows);
    expect(out[0]).toEqual([...DAILY_REVENUE_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08", "CBC", "CBC", "lab_test", 2, "350.00"]);
    expect(out[2]).toEqual(["2026-09-08", "FBS", "FBS", "lab_test", 1, "120.50"]);
    expect(out[3]).toEqual(["2026-09-07", "CBC", "CBC", "lab_test", 0, "0.00"]);
  });
});

describe("href / filename", () => {
  const p = { from: "2026-09-01", to: "2026-09-08" };
  it("carries the same filters the page shows", () => {
    expect(dailyRevenueCsvHref(p)).toBe("/api/admin/reports/daily-revenue.csv?from=2026-09-01&to=2026-09-08");
    expect(dailyRevenueCsvFilename(p)).toBe("daily-revenue-2026-09-01_2026-09-08.csv");
  });
});
