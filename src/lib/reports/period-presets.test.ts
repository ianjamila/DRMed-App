import { describe, it, expect } from "vitest";
import { buildPeriodPresets, buildAsOfPresets, priorYearRange } from "./period-presets";

const by = <T extends { key: string }>(rows: T[], key: string) =>
  rows.find((r) => r.key === key)!;

describe("buildPeriodPresets", () => {
  // M2: the whole point. Manila midnight is 16:00 UTC the PREVIOUS day, so the
  // old `new Date(...).getUTCMonth()` read the month before on every 1st.
  it("is correct on the 1st of a month — the day you close the books", () => {
    const p = buildPeriodPresets("2026-09-01");
    expect(by(p, "this-month").start).toBe("2026-09-01");
    expect(by(p, "this-month").end).toBe("2026-09-01");
    expect(by(p, "last-month")).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("is correct on 1 January — YTD is this year, not all of last year", () => {
    const p = buildPeriodPresets("2026-01-01");
    expect(by(p, "ytd")).toMatchObject({ start: "2026-01-01", end: "2026-01-01" });
    expect(by(p, "last-month")).toMatchObject({ start: "2025-12-01", end: "2025-12-31" });
    expect(by(p, "this-year")).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
    expect(by(p, "last-year")).toMatchObject({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("still agrees with the old behaviour mid-month", () => {
    const p = buildPeriodPresets("2026-09-14");
    expect(by(p, "this-month")).toMatchObject({ start: "2026-09-01", end: "2026-09-14" });
    expect(by(p, "last-month")).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
    expect(by(p, "ytd")).toMatchObject({ start: "2026-01-01", end: "2026-09-14" });
  });

  it("counts 12 months back inclusive of the current month, across the year wrap", () => {
    expect(by(buildPeriodPresets("2026-09-14"), "12m").start).toBe("2025-10-01");
    expect(by(buildPeriodPresets("2026-01-01"), "12m").start).toBe("2025-02-01");
  });

  it("ends last-month on the 29th in a leap February", () => {
    expect(by(buildPeriodPresets("2024-03-01"), "last-month").end).toBe("2024-02-29");
    expect(by(buildPeriodPresets("2026-03-01"), "last-month").end).toBe("2026-02-28");
  });

  it("labels this/last year from the Manila year, on 1 January too", () => {
    const p = buildPeriodPresets("2026-01-01");
    expect(by(p, "this-year").label).toBe("This year (2026)");
    expect(by(p, "last-year").label).toBe("Last year (2025)");
  });
});

describe("buildAsOfPresets", () => {
  it("is correct on the 1st — end of last month is the month that just ended", () => {
    const p = buildAsOfPresets("2026-09-01");
    expect(by(p, "today").date).toBe("2026-09-01");
    expect(by(p, "prev-month").date).toBe("2026-08-31");
  });

  it("picks the end of the previous calendar quarter", () => {
    expect(by(buildAsOfPresets("2026-09-14"), "prev-q").date).toBe("2026-06-30"); // Q3 → end Q2
    expect(by(buildAsOfPresets("2026-02-10"), "prev-q").date).toBe("2025-12-31"); // Q1 → end prior Q4
    expect(by(buildAsOfPresets("2026-01-01"), "prev-q").date).toBe("2025-12-31");
    expect(by(buildAsOfPresets("2026-11-30"), "prev-q").date).toBe("2026-09-30");
  });

  it("names and dates the prior year-ends off the Manila year", () => {
    const p = buildAsOfPresets("2026-01-01");
    expect(by(p, "prev-year")).toMatchObject({ label: "End of 2025", date: "2025-12-31" });
    expect(by(p, "two-years")).toMatchObject({ label: "End of 2024", date: "2024-12-31" });
  });
});

describe("priorYearRange", () => {
  it("shifts both ends back one year", () => {
    expect(priorYearRange("2026-01-01", "2026-05-28")).toEqual({
      start: "2025-01-01",
      end: "2025-05-28",
    });
  });

  it("clamps 29 February back to a real day in a common year", () => {
    // Left unclamped this produced "2027-02-29", which the regex guard accepts
    // and `new Date()` silently rolls over to 1 March — a one-day shift in the
    // comparison column.
    expect(priorYearRange("2028-02-29", "2028-02-29")).toEqual({
      start: "2027-02-28",
      end: "2027-02-28",
    });
    expect(priorYearRange("2024-02-29", "2024-02-29")).toEqual({
      start: "2023-02-28",
      end: "2023-02-28",
    });
  });
});
