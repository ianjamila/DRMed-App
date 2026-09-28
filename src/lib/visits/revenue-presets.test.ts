import { describe, expect, it } from "vitest";
import {
  buildRevenuePresets,
  isRevenuePresetKey,
  matchRevenuePreset,
  REVENUE_PRESET_KEYS,
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
