import { describe, expect, it } from "vitest";
import { eodClosedMessage } from "./eod-closed-message";

// The exact shape 0043's eod_lock_check raises (date::text, shift code, timestamptz::text).
const DB_MESSAGE =
  "EOD already closed for business_date 2026-09-24 (shift AM) at 2026-09-24 02:15:32.123+00. " +
  "Ask an admin to reopen the close before recording further activity.";

describe("eodClosedMessage", () => {
  it("names the closed day from the database message", () => {
    expect(eodClosedMessage(DB_MESSAGE)).toBe(
      "End of Day is already closed for Thursday, September 24, 2026, so nothing more can be recorded on that day. Ask an admin to reopen it first.",
    );
  });

  it("never leaks the column name, shift code or UTC timestamp", () => {
    const text = eodClosedMessage(DB_MESSAGE);
    for (const leak of ["business_date", "EOD", "shift AM", "+00", "02:15"]) {
      expect(text).not.toContain(leak);
    }
  });

  it.each([undefined, "", "some other wording", "business_date 2026-13-45"])(
    "falls back to the dateless sentence for %j",
    (input) => {
      expect(eodClosedMessage(input)).toBe(
        "End of Day is already closed for that date, so nothing more can be recorded on it. Ask an admin to reopen it first.",
      );
    },
  );
});
