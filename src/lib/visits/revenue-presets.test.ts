import { describe, expect, it } from "vitest";
import {
  buildRevenuePresets,
  isRevenuePresetKey,
  matchRevenuePreset,
  REVENUE_PRESET_KEYS,
  trendMonthHref,
  trendMonths,
  yearOnYearChange,
} from "./revenue-presets";

describe("buildRevenuePresets", () => {
  it("builds the five ranges in order, mid-month", () => {
    expect(buildRevenuePresets("2026-09-28")).toEqual([
      { key: "this-month", label: "This month", start: "2026-09-01", end: "2026-09-28" },
      { key: "last-month", label: "Last month", start: "2026-08-01", end: "2026-08-31" },
      { key: "ytd", label: "Year-to-date", start: "2026-01-01", end: "2026-09-28" },
      { key: "last-year", label: "Last year (2025)", start: "2025-01-01", end: "2025-12-31" },
      { key: "all", label: "All dates", start: "", end: "" },
    ]);
  });

  it("is right on 1 January (the M2 day)", () => {
    const [thisMonth, lastMonth, ytd, lastYear] = buildRevenuePresets("2027-01-01");
    expect(thisMonth).toMatchObject({ start: "2027-01-01", end: "2027-01-01" });
    expect(lastMonth).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
    expect(ytd).toMatchObject({ start: "2027-01-01", end: "2027-01-01" });
    expect(lastYear).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("covers every declared key exactly once", () => {
    expect(buildRevenuePresets("2026-09-28").map((p) => p.key)).toEqual([...REVENUE_PRESET_KEYS]);
  });
});

describe("matchRevenuePreset", () => {
  const presets = buildRevenuePresets("2026-09-28");

  it("finds the preset for an exact range", () => {
    expect(matchRevenuePreset(presets, "2026-08-01", "2026-08-31")?.key).toBe("last-month");
    expect(matchRevenuePreset(presets, "", "")?.key).toBe("all");
  });

  it("returns nothing for a custom range", () => {
    expect(matchRevenuePreset(presets, "2026-08-01", "2026-08-30")).toBeUndefined();
    expect(matchRevenuePreset(presets, "2026-09-01", "")).toBeUndefined();
  });
});

describe("isRevenuePresetKey", () => {
  it("accepts the keys and rejects anything else", () => {
    expect(isRevenuePresetKey("ytd")).toBe(true);
    expect(isRevenuePresetKey("12m")).toBe(false);
    expect(isRevenuePresetKey(undefined)).toBe(false);
  });
});

describe("yearOnYearChange", () => {
  it("formats growth, decline and flat", () => {
    expect(yearOnYearChange(112, 100)).toBe("+12%");
    expect(yearOnYearChange(95, 100)).toBe("−5%");
    expect(yearOnYearChange(100.2, 100)).toBe("0%");
  });

  it("has no percentage when last year was zero", () => {
    expect(yearOnYearChange(500, 0)).toBeNull();
    expect(yearOnYearChange(0, 0)).toBeNull();
  });
});

describe("trendMonths", () => {
  it("returns the 12 months ending with the current, partial one", () => {
    const m = trendMonths("2026-09-28");
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ key: "2025-10", label: "Oct", year: 2025, start: "2025-10-01", end: "2025-10-31", partial: false });
    expect(m[11]).toEqual({ key: "2026-09", label: "Sep", year: 2026, start: "2026-09-01", end: "2026-09-28", partial: true });
    expect(m.map((x) => x.key)).toEqual([
      "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
  });

  it("handles February and the 1st of January", () => {
    const m = trendMonths("2027-01-01", 3);
    expect(m.map((x) => [x.start, x.end])).toEqual([
      ["2026-11-01", "2026-11-30"],
      ["2026-12-01", "2026-12-31"],
      ["2027-01-01", "2027-01-01"],
    ]);
    expect(trendMonths("2028-03-05", 2)[0]).toMatchObject({ start: "2028-02-01", end: "2028-02-29" });
  });
});

describe("trendMonthHref", () => {
  it("opens Visit Records over the month with the dropdown open", () => {
    expect(trendMonthHref({ start: "2026-08-01", end: "2026-08-31" })).toBe(
      "/staff/visits?start=2026-08-01&end=2026-08-31&rev=1",
    );
  });

  it("carries a non-default view so the list matches the bar", () => {
    expect(trendMonthHref({ start: "2026-09-01", end: "2026-09-28" }, "deleted")).toBe(
      "/staff/visits?start=2026-09-01&end=2026-09-28&view=deleted&rev=1",
    );
  });
});
