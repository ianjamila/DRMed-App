import { describe, expect, it } from "vitest";
import { manilaDate, manilaDateTime, manilaTime } from "./manila";

/**
 * These pin the EXACT rendered strings on purpose.
 *
 * The format shipped wrong once: the formatter was written against `en-GB`,
 * which renders "11 Sept 2026" — day-first, and with a four-letter "Sept" that
 * reads inconsistently beside `friendlyManilaDate` and the appointments list.
 * Nothing caught it, because every other test only asserted that *a* string
 * came back. Asserting the literal output is the point.
 */
describe("manilaDate", () => {
  it("renders month-first with a spelled month", () => {
    expect(manilaDate("2026-09-11")).toBe("Sep 11, 2026");
  });

  it("never renders day-first or a numeric month", () => {
    const out = manilaDate("2026-09-11");
    expect(out).not.toBe("11 Sep 2026");
    expect(out).not.toBe("11 Sept 2026");
    expect(out).not.toMatch(/^\d{1,2}\//); // 9/11/2026
  });

  it("keeps a bare calendar date on its own Manila day", () => {
    // Parsed naively this is UTC midnight, which renders as the previous day
    // for any formatter west of Manila.
    expect(manilaDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(manilaDate("2026-12-31")).toBe("Dec 31, 2026");
  });

  it("renders a timestamptz in Manila, not UTC", () => {
    // 2026-09-11T17:30Z is 01:30 on the 12th in Manila (UTC+8).
    expect(manilaDate("2026-09-11T17:30:00Z")).toBe("Sep 12, 2026");
  });

  it("returns an em-dash for nothing, rather than 'Invalid Date'", () => {
    expect(manilaDate(null)).toBe("—");
    expect(manilaDate(undefined)).toBe("—");
    expect(manilaDate("")).toBe("—");
    expect(manilaDate("not a date")).toBe("—");
  });
});

describe("manilaTime", () => {
  it("renders a 12-hour Manila clock time", () => {
    expect(manilaTime("2026-09-11T06:06:00Z")).toBe("2:06 PM");
  });

  it("returns an em-dash for nothing", () => {
    expect(manilaTime(null)).toBe("—");
  });
});

describe("manilaDateTime", () => {
  it("is the canonical date, then the time", () => {
    expect(manilaDateTime("2026-09-11T06:06:00Z")).toBe("Sep 11, 2026, 2:06 PM");
  });

  it("returns an em-dash for nothing", () => {
    expect(manilaDateTime(null)).toBe("—");
  });
});
