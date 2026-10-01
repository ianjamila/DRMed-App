import { describe, expect, it } from "vitest";
import {
  aggregateSpend,
  DIGEST_ALERT_KEY,
  digestPeriods,
  periodEnd,
  retryPeriodError,
  spendIn,
} from "./patient-sources-digest";

describe("digestPeriods", () => {
  it("weekly on a Monday: the Mon–Sun week just ended, against the week before", () => {
    expect(digestPeriods("week", "2026-10-05")).toEqual({
      cur: { from: "2026-09-28", to: "2026-10-04" },
      prev: { from: "2026-09-21", to: "2026-09-27" },
      tooEarly: false,
    });
  });
  it("monthly on the 1st: the month just ended, against the month before", () => {
    expect(digestPeriods("month", "2026-10-01")).toEqual({
      cur: { from: "2026-09-01", to: "2026-09-30" },
      prev: { from: "2026-08-01", to: "2026-08-31" },
      tooEarly: false,
    });
  });
  it("is leap-February and year-boundary safe", () => {
    expect(digestPeriods("month", "2024-03-01").cur).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(digestPeriods("month", "2024-03-01").prev).toEqual({ from: "2024-01-01", to: "2024-01-31" });
    expect(digestPeriods("month", "2027-01-01").cur).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(digestPeriods("week", "2027-01-04").cur).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
  it("drops the comparison (null) when the period before starts before Patient Sources' first date", () => {
    const m = digestPeriods("month", "2024-01-01"); // current = Dec 2023, previous would be Nov 2023
    expect(m.cur).toEqual({ from: "2023-12-01", to: "2023-12-31" });
    expect(m.prev).toBeNull();
    expect(m.tooEarly).toBe(false);
    const w = digestPeriods("week", "2023-12-11"); // current = Mon 4 Dec, previous = Mon 27 Nov
    expect(w.cur).toEqual({ from: "2023-12-04", to: "2023-12-10" });
    expect(w.prev).toBeNull();
    expect(w.tooEarly).toBe(false);
  });
  it("is too_early when the CURRENT period starts before the first date", () => {
    expect(digestPeriods("month", "2023-12-15").tooEarly).toBe(true); // Nov 2023
    expect(digestPeriods("week", "2023-12-04")).toMatchObject({ cur: { from: "2023-11-27", to: "2023-12-03" }, prev: null, tooEarly: true });
  });
});

describe("periodEnd", () => {
  it("is Sunday for a week and the last day for a month", () => {
    expect(periodEnd("week", "2026-09-28")).toBe("2026-10-04");
    expect(periodEnd("month", "2024-02-01")).toBe("2024-02-29");
    expect(periodEnd("month", "2026-12-01")).toBe("2026-12-31");
  });
});

describe("retryPeriodError (?period_from=)", () => {
  it("accepts a finished Monday week / 1st-of-month period not older than 62 days", () => {
    expect(retryPeriodError("week", "2026-10-05", "2026-10-12")).toBeNull();
    expect(retryPeriodError("month", "2026-10-01", "2026-12-01")).toBeNull(); // 61 days old
    expect(retryPeriodError("month", "2026-10-01", "2026-12-02")).toBeNull(); // exactly 62
  });
  it("refuses a period that is more than 62 days old (measured from its start)", () => {
    expect(retryPeriodError("month", "2026-10-01", "2026-12-03")).toMatch(/62 days/); // 63 days old
    expect(retryPeriodError("month", "2026-10-01", "2026-12-04")).toMatch(/62 days/);
    expect(retryPeriodError("week", "2026-07-27", "2026-10-12")).toMatch(/62 days/);
  });
  it("refuses a period that has not finished", () => {
    expect(retryPeriodError("week", "2026-10-12", "2026-10-12")).toMatch(/not finished/);
    expect(retryPeriodError("week", "2026-10-12", "2026-10-18")).toMatch(/not finished/); // ends today
    expect(retryPeriodError("month", "2026-10-01", "2026-10-31")).toMatch(/not finished/);
  });
  it("refuses a start that is not a Monday (weekly) or the 1st (monthly)", () => {
    expect(retryPeriodError("week", "2026-10-07", "2026-10-20")).toMatch(/Monday/);
    expect(retryPeriodError("month", "2026-10-05", "2026-11-20")).toMatch(/1st/);
  });
  it("refuses something that is not a real date", () => {
    expect(retryPeriodError("month", "banana", "2026-11-20")).toMatch(/real date/);
    expect(retryPeriodError("month", "2026-02-31", "2026-11-20")).toMatch(/real date/);
  });
});

describe("aggregateSpend", () => {
  it("sums per date × platform in whole cents and sorts by date then platform", () => {
    const out = aggregateSpend([
      { spend_date: "2026-09-29", platform: "meta", spend_php: "7.5" },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.1 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 0.2 },
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
    ]);
    expect(out).toEqual([
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.3 },
      { spend_date: "2026-09-29", platform: "meta", spend_php: 7.5 },
    ]);
  });
  it("refuses a platform it does not know rather than dropping its spend", () => {
    expect(() => aggregateSpend([{ spend_date: "2026-09-28", platform: "tiktok", spend_php: 1 }])).toThrow(/platform/);
  });
});

describe("spendIn / keys", () => {
  it("keeps only spend inside the period", () => {
    const rows = [
      { spend_date: "2026-09-27", platform: "meta" as const, spend_php: 1 },
      { spend_date: "2026-09-28", platform: "meta" as const, spend_php: 2 },
      { spend_date: "2026-10-05", platform: "meta" as const, spend_php: 3 },
    ];
    expect(spendIn(rows, { from: "2026-09-28", to: "2026-10-04" })).toEqual([rows[1]]);
  });
  it("maps each period to its alert key", () => {
    expect(DIGEST_ALERT_KEY).toEqual({ week: "patient_sources_weekly", month: "patient_sources_monthly" });
  });
});