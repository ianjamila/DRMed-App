import { describe, it, expect, vi, afterEach } from "vitest";
import {
  firstOfMonthISO,
  friendlyManilaDate,
  isoDateParts,
  lastOfMonthISO,
  isISODate,
  manilaDayWindowUtc,
  manilaRangeUtc,
  shiftISODate,
} from "./manila";

describe("manilaDayWindowUtc", () => {
  afterEach(() => vi.useRealTimers());

  it("maps tomorrow's Manila day to a fixed +08:00 UTC window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z")); // 17:00 Manila on 06-16
    const { startIso, endIso } = manilaDayWindowUtc(1);
    // Manila 2026-06-17 00:00 = UTC 2026-06-16 16:00; +24h = 2026-06-17 16:00.
    expect(startIso).toBe("2026-06-16T16:00:00.000Z");
    expect(endIso).toBe("2026-06-17T16:00:00.000Z");
  });

  it("offset 0 is today's Manila day and the window is exactly 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z"));
    const { startIso, endIso } = manilaDayWindowUtc(0);
    expect(startIso).toBe("2026-06-15T16:00:00.000Z");
    expect(new Date(endIso).getTime() - new Date(startIso).getTime()).toBe(86_400_000);
  });

  it("crosses a month boundary correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T15:00:00Z")); // 23:00 Manila on 06-30
    const { startIso } = manilaDayWindowUtc(1); // tomorrow Manila = 2026-07-01
    expect(startIso).toBe("2026-06-30T16:00:00.000Z");
  });
});

describe("isISODate", () => {
  it("accepts a well-formed YYYY-MM-DD", () => {
    expect(isISODate("2026-07-27")).toBe(true);
  });

  it("rejects junk, partial dates, blanks and nullish", () => {
    for (const bad of ["", "2026-7-27", "27/07/2026", "2026-07-27T00:00", "tomorrow", null, undefined]) {
      expect(isISODate(bad)).toBe(false);
    }
  });
});

describe("shiftISODate", () => {
  it("steps forward and back a day", () => {
    expect(shiftISODate("2026-07-27", 1)).toBe("2026-07-28");
    expect(shiftISODate("2026-07-27", -1)).toBe("2026-07-26");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftISODate("2026-06-30", 1)).toBe("2026-07-01");
    expect(shiftISODate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(shiftISODate("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("manilaRangeUtc", () => {
  it("maps an inclusive Manila day range to a half-open UTC window", () => {
    const { fromIso, toIso } = manilaRangeUtc("2026-07-27", "2026-07-28");
    // Manila midnight is 16:00 UTC the previous day; `to` is the day AFTER the
    // end date so the whole end day is inside the window.
    expect(fromIso).toBe("2026-07-26T16:00:00.000Z");
    expect(toIso).toBe("2026-07-28T16:00:00.000Z");
  });

  it("covers a full 24h when start and end are the same day", () => {
    const { fromIso, toIso } = manilaRangeUtc("2026-07-27", "2026-07-27");
    expect(new Date(toIso!).getTime() - new Date(fromIso!).getTime()).toBe(86_400_000);
  });

  it("keeps a 23:59 Manila timestamp inside the end day", () => {
    const { toIso } = manilaRangeUtc("", "2026-07-27");
    const lateManila = new Date("2026-07-27T23:59:59+08:00").toISOString();
    expect(lateManila < toIso!).toBe(true);
  });

  it("leaves a bound open when that side is blank or invalid", () => {
    expect(manilaRangeUtc("", "")).toEqual({ fromIso: null, toIso: null });
    expect(manilaRangeUtc("2026-07-27", "nope").toIso).toBeNull();
    expect(manilaRangeUtc(null, "2026-07-27").fromIso).toBeNull();
  });
});

describe("friendlyManilaDate", () => {
  it("renders weekday and long date in Manila time", () => {
    expect(friendlyManilaDate("2026-07-27")).toBe("Monday, July 27, 2026");
  });
});

describe("Manila calendar arithmetic (isoDateParts / firstOfMonthISO / lastOfMonthISO)", () => {
  it("reads the calendar parts straight off the string, with no Date in between", () => {
    // The bug these replace: `new Date("2026-09-01T00:00:00+08:00")` is
    // 2026-08-31T16:00Z, so getUTCMonth() said August on the 1st of September.
    expect(isoDateParts("2026-09-01")).toEqual({ year: 2026, month: 9, day: 1 });
    expect(isoDateParts("2026-01-01")).toEqual({ year: 2026, month: 1, day: 1 });
    expect(isoDateParts("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it("builds the first of a month", () => {
    expect(firstOfMonthISO(2026, 9)).toBe("2026-09-01");
    expect(firstOfMonthISO(2026, 12)).toBe("2026-12-01");
  });

  it("normalises a month outside 1-12 into the neighbouring year", () => {
    expect(firstOfMonthISO(2026, 0)).toBe("2025-12-01"); // month before January
    expect(firstOfMonthISO(2026, 13)).toBe("2027-01-01");
    expect(firstOfMonthISO(2026, -2)).toBe("2025-10-01"); // 12 months back from Sep
  });

  it("builds the last of a month, including February in leap and common years", () => {
    expect(lastOfMonthISO(2026, 2)).toBe("2026-02-28");
    expect(lastOfMonthISO(2024, 2)).toBe("2024-02-29"); // divisible by 4
    expect(lastOfMonthISO(2000, 2)).toBe("2000-02-29"); // divisible by 400
    expect(lastOfMonthISO(1900, 2)).toBe("1900-02-28"); // divisible by 100, not 400
    expect(lastOfMonthISO(2026, 4)).toBe("2026-04-30");
    expect(lastOfMonthISO(2026, 12)).toBe("2026-12-31");
  });

  it("normalises out-of-range months when taking the last day too", () => {
    expect(lastOfMonthISO(2026, 0)).toBe("2025-12-31");
    expect(lastOfMonthISO(2027, 13)).toBe("2028-01-31");
  });
});
