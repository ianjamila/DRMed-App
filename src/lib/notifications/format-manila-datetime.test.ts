import { describe, expect, it } from "vitest";
import { formatManilaDateTime } from "./format-manila-datetime";

describe("formatManilaDateTime", () => {
  it("renders a UTC instant as Manila wall-clock time, not the server's raw UTC time", () => {
    // 2026-01-15T06:00:00Z is 2:00 PM in Asia/Manila (UTC+8). Regression
    // guard for A7: booking confirmation emails and the public cancel page
    // called toLocaleString with no `timeZone`, so on Vercel (UTC runtime)
    // this rendered as "6:00 AM" instead of the correct "2:00 PM".
    const s = formatManilaDateTime("2026-01-15T06:00:00.000Z");
    expect(s).toContain("2:00 PM");
    expect(s).not.toContain("6:00 AM");
  });

  it("crosses the Manila calendar-day boundary correctly near UTC midnight", () => {
    // 2026-01-15T16:30:00Z is 2026-01-16, 12:30 AM in Manila — a naive
    // server-clock render would still say "January 15".
    const s = formatManilaDateTime("2026-01-15T16:30:00.000Z");
    expect(s).toContain("January 16, 2026");
  });
});
