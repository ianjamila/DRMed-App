import { describe, expect, it } from "vitest";
import { daysBetweenISO } from "@/lib/dates/manila";
import { buildMarketingPresets, firstParam, periodHref, resolvePeriod, MAX_PERIOD_DAYS, PATIENT_SOURCES_MIN_DATE } from "./period";

describe("buildMarketingPresets", () => {
  it("lists the recent presets first, then the longer ones", () => {
    expect(buildMarketingPresets("2026-09-28").map((p) => p.key)).toEqual([
      "today", "yesterday", "last-7", "this-month", "last-month", "ytd", "12m", "last-year",
    ]);
  });
  it("is right on the 1st of a month (Manila calendar, no Date)", () => {
    const p = Object.fromEntries(buildMarketingPresets("2026-09-01").map((x) => [x.key, x]));
    expect(p.today).toMatchObject({ start: "2026-09-01", end: "2026-09-01" });
    expect(p.yesterday).toMatchObject({ start: "2026-08-31", end: "2026-08-31" });
    expect(p["last-7"]).toMatchObject({ start: "2026-08-26", end: "2026-09-01" });
    expect(p["this-month"]).toMatchObject({ start: "2026-09-01", end: "2026-09-01" });
    expect(p["last-month"]).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
  });
  it("is right on 1 January", () => {
    const p = Object.fromEntries(buildMarketingPresets("2027-01-01").map((x) => [x.key, x]));
    expect(p.yesterday).toMatchObject({ start: "2026-12-31", end: "2026-12-31" });
    expect(p["last-month"]).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
    expect(p.ytd).toMatchObject({ start: "2027-01-01", end: "2027-01-01" });
    expect(p["last-year"]).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
  });
  it("keeps every preset within the maximum span", () => {
    for (const today of ["2026-12-31", "2028-02-29", "2027-01-01"]) {
      for (const p of buildMarketingPresets(today)) {
        expect(daysBetweenISO(p.start, p.end)).toBeLessThanOrEqual(MAX_PERIOD_DAYS);
      }
    }
  });
});

describe("resolvePeriod", () => {
  const today = "2026-09-28";
  it("defaults to this month", () => {
    expect(resolvePeriod({}, today)).toEqual({ from: "2026-09-01", to: "2026-09-28", presetKey: "this-month", error: null, problem: null });
  });
  it("accepts a valid custom range and marks it custom", () => {
    expect(resolvePeriod({ from: "2026-07-03", to: "2026-08-14" }, today)).toEqual({
      from: "2026-07-03", to: "2026-08-14", presetKey: null, error: null, problem: null,
    });
  });
  it("accepts a real leap day", () => {
    expect(resolvePeriod({ from: "2028-02-29", to: "2028-03-01" }, "2028-03-02").error).toBeNull();
  });
  it("recognises a preset range", () => {
    expect(resolvePeriod({ from: "2026-09-27", to: "2026-09-27" }, today).presetKey).toBe("yesterday");
  });
  it("rejects reversed, malformed and over-long ranges with a message", () => {
    for (const bad of [
      { from: "2026-09-10", to: "2026-09-01" },
      { from: "2026-9-1", to: "2026-09-10" },
      { from: "2025-01-01", to: "2026-09-10" },
      { from: "2026-09-01" },
      { from: "2026-02-30", to: "2026-03-05" },
      { from: "2027-02-29", to: "2027-03-01" },
    ]) {
      const r = resolvePeriod(bad, today);
      expect(r.from).toBe("2026-09-01");
      expect(r.to).toBe("2026-09-28");
      expect(r.error).toMatch(/400 days/);
    }
  });
});

describe("Patient Sources lower bound (0193 P2)", () => {
  const today = "2026-09-28";
  const min = { min: PATIENT_SOURCES_MIN_DATE };
  it("refuses a custom start before 2023-12-01 with a plain message and falls back to this month", () => {
    const r = resolvePeriod({ from: "2023-11-30", to: "2023-12-31" }, today, min);
    expect(r).toMatchObject({ from: "2026-09-01", to: "2026-09-28", presetKey: "this-month" });
    expect(r.problem).toMatch(/1 December 2023/);
    expect(r.error).toMatch(/Showing this month instead/);
  });
  it("accepts a start of exactly 2023-12-01, and does not apply the bound unless asked (Booking Sources)", () => {
    expect(resolvePeriod({ from: "2023-12-01", to: "2023-12-31" }, today, min).problem).toBeNull();
    expect(resolvePeriod({ from: "2022-06-01", to: "2022-06-30" }, today).problem).toBeNull();
  });
  it("clamps a preset that starts before the bound and drops one that ends before it", () => {
    const early = buildMarketingPresets("2024-01-10", min);
    const p = Object.fromEntries(early.map((x) => [x.key, x]));
    expect(p["12m"].start).toBe("2023-12-01");
    expect(p["last-year"]).toMatchObject({ start: "2023-12-01", end: "2023-12-31" });
    expect(buildMarketingPresets("2023-11-15", min)).toEqual([]); // every preset ends before the bound
  });
  it("a plain-period error carries a problem for the CSV routes", () => {
    expect(resolvePeriod({ from: "2026-09-10", to: "2026-09-01" }, today, min).problem).toMatch(/400 days/);
  });
});

describe("periodHref", () => {
  it("keeps other params, applies the patch, drops null and empty", () => {
    expect(periodHref("/x", { from: "a", to: "b", mode: "served", grain: "week", page: "3" }, { from: "c", to: "d", page: null }))
      .toBe("/x?mode=served&grain=week&from=c&to=d");
    expect(periodHref("/x", {}, {})).toBe("/x");
    expect(periodHref("/x", { mode: "" }, { grain: "day" })).toBe("/x?grain=day");
  });
});

describe("firstParam", () => {
  it("reads the first string of a search param", () => {
    expect(firstParam("a")).toBe("a");
    expect(firstParam(["b", "c"])).toBe("b");
    expect(firstParam(undefined)).toBeUndefined();
  });
});
