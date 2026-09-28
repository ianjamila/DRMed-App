import { describe, expect, it } from "vitest";
import { formatBulkOutcome } from "./bulk-outcome";

const bookings = { one: "booking", many: "bookings" };

describe("formatBulkOutcome", () => {
  it("all changed: one sentence", () => {
    expect(
      formatBulkOutcome({ verb: "Cancelled", noun: bookings, sent: 3, changed: 3, notChanged: [] }),
    ).toBe("Cancelled 3 bookings.");
  });
  it("singular noun and tail", () => {
    expect(
      formatBulkOutcome({ verb: "Marked", tail: "as no-show", noun: bookings, sent: 1, changed: 1, notChanged: [] }),
    ).toBe("Marked 1 booking as no-show.");
  });
  it("names every row not changed, then every row never sent", () => {
    expect(
      formatBulkOutcome({
        verb: "Marked",
        tail: "arrived",
        noun: bookings,
        sent: 3,
        changed: 1,
        notChanged: [
          { label: "Santos, Maria", reason: "had already changed — refresh to see its status" },
          { label: "Cruz, Ana, 3 services", reason: "partly changed — open it to check" },
        ],
        notSent: [{ label: "Reyes, Jo", reason: "patient record deleted or merged" }],
      }),
    ).toBe(
      [
        "Marked 1 of 3 bookings arrived.",
        "Not changed (2):",
        "• Santos, Maria: had already changed — refresh to see its status",
        "• Cruz, Ana, 3 services: partly changed — open it to check",
        "Skipped (1):",
        "• Reyes, Jo: patient record deleted or merged",
      ].join("\n"),
    );
  });
  it("nothing changed", () => {
    expect(
      formatBulkOutcome({ verb: "Claimed", noun: { one: "test", many: "tests" }, sent: 2, changed: 0, notChanged: [] }),
    ).toBe("Nothing claimed.");
  });
});
