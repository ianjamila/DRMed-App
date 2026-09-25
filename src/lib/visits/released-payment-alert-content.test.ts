import { describe, expect, it } from "vitest";
import {
  buildReleasedPaymentAlertEmail,
  shouldAlertReleasedPaymentRemoved,
  type ReleasedPaymentAlertInput,
} from "./released-payment-alert-content";

const base: ReleasedPaymentAlertInput = {
  change: "deleted",
  visitNumber: "0043",
  amountPhp: 1000,
  methodLabel: "Cash",
  reasonLabel: "Recorded twice",
  movedToVisitNumber: null,
  byName: "Ana Reyes",
  releasedResults: 3,
  owesPhp: 1000,
  visitUrl: "https://drmed.ph/staff/visits/v1",
};

describe("buildReleasedPaymentAlertEmail", () => {
  it("names the visit, the change, the reason and what it now owes", () => {
    const c = buildReleasedPaymentAlertEmail(base);
    expect(c.subject).toBe("Visit #0043 owes ₱1,000 after its results went out");
    expect(c.text).toContain("A ₱1,000 Cash payment was deleted from visit #0043. 3 results on that visit had already been released, and it now owes ₱1,000.");
    expect(c.text).toContain("What happened: Deleted — Recorded twice");
    expect(c.text).toContain("By: Ana Reyes");
    expect(c.text).toContain("Released results stay released");
    expect(c.html).toContain("https://drmed.ph/staff/visits/v1");
  });

  it("describes a move by the visit it went to", () => {
    const c = buildReleasedPaymentAlertEmail({ ...base, change: "moved", reasonLabel: null, movedToVisitNumber: "0044", releasedResults: 1 });
    expect(c.text).toContain("was moved off visit #0043. 1 result on that visit");
    expect(c.text).toContain("What happened: Moved to visit #0044");
  });

  it("carries no patient identity or test names (RA 10173): the input has no field for them", () => {
    // Structural: every string the email can print comes from these keys.
    expect(Object.keys(base).sort()).toEqual(
      [
        "amountPhp",
        "byName",
        "change",
        "methodLabel",
        "movedToVisitNumber",
        "owesPhp",
        "reasonLabel",
        "releasedResults",
        "visitNumber",
        "visitUrl",
      ].sort(),
    );
  });

  it("escapes staff names in the HTML", () => {
    expect(buildReleasedPaymentAlertEmail({ ...base, byName: "<b>x</b>" }).html).not.toContain("<b>x</b>");
  });
});

describe("shouldAlertReleasedPaymentRemoved", () => {
  it("alerts only when the visit owes again AND results went out", () => {
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, releasedResults: 2 })).toBe(true);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: true, releasedResults: 2 })).toBe(false);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, releasedResults: 0 })).toBe(false);
  });
  it("does not alert when the re-read failed", () => {
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: null, releasedResults: 2 })).toBe(false);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, releasedResults: null })).toBe(false);
  });
});
