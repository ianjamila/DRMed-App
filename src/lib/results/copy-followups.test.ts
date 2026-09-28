import { describe, expect, it } from "vitest";
import {
  cappedCountLabel,
  copyKindLabel,
  followUpStatusLabel,
  notifyProblemHint,
  isOutdatedCopiesCapped,
  outdatedCopyChip,
  shouldOfferNotify,
  type CopyState,
} from "./copy-followups";

const base: CopyState = {
  result_id: "r1", latest_amendment_id: "a1", amendment_count: 1,
  amended_at: "2026-09-25T02:00:00.000001+00:00",
  holds_copy: true, portal_outdated: true, printed_outdated: false,
  followed_up: false, notified_at: null, notify_failed: false,
  has_email: true, has_phone: false,
};

describe("shouldOfferNotify", () => {
  it("offers when the patient holds a copy and can be reached", () => {
    expect(shouldOfferNotify(base)).toEqual({ offered: true });
  });
  it("does not offer when the patient never downloaded or was handed a copy", () => {
    expect(shouldOfferNotify({ ...base, holds_copy: false })).toEqual({
      offered: false, reason: "The patient hasn't downloaded or been handed a copy yet.",
    });
  });
  it("does not offer without an email or mobile number", () => {
    expect(shouldOfferNotify({ ...base, has_email: false, has_phone: false })).toEqual({
      offered: false, reason: "No email or mobile number on file.",
    });
  });
  it("does not offer when the state could not be read", () => {
    expect(shouldOfferNotify(undefined).offered).toBe(false);
  });
});

describe("copyKindLabel", () => {
  it.each([
    [true, false, "Portal download"],
    [false, true, "Printed copy"],
    [true, true, "Portal download + printed copy"],
  ])("portal=%s printed=%s → %s", (portal, printed, label) => {
    expect(copyKindLabel({ portal_outdated: portal, printed_outdated: printed })).toBe(label);
  });
});

describe("followUpStatusLabel", () => {
  it("contacted wins", () => {
    expect(followUpStatusLabel({ contacted_at: "x", notified_at: null, notify_failed: false, notified_channels: null }))
      .toBe("Contacted");
  });
  it("names the channels that went out", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: false, notified_channels: ["email", "sms"] }))
      .toBe("Notified by email and SMS");
  });
  it("a failed send stays visible", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: true, notified_channels: [] }))
      .toBe("Send failed — call the patient");
  });
  it("a claim with no record yet counts as not sent", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: false, notified_channels: null }))
      .toBe("Send status unknown — call the patient");
  });
  it("nothing yet", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: null, notify_failed: false, notified_channels: null }))
      .toBe("Not contacted");
  });
});

describe("notifyProblemHint", () => {
  it("names each cause in plain words while the patient is still to be contacted", () => {
    expect(notifyProblemHint({ contacted_at: null, notify_problem: "not_set_up" })).toBe(
      "Email and text notices aren't set up — tell an admin.",
    );
    expect(notifyProblemHint({ contacted_at: null, notify_problem: "no_contact" })).toBe("No phone or email on file.");
    expect(notifyProblemHint({ contacted_at: null, notify_problem: "send_error" })).toBe("The email or text didn't go through.");
  });
  it("says nothing once contacted, for no problem, or for an unknown category", () => {
    expect(notifyProblemHint({ contacted_at: "2026-09-28T00:00:00Z", notify_problem: "send_error" })).toBeNull();
    expect(notifyProblemHint({ contacted_at: null, notify_problem: null })).toBeNull();
    expect(notifyProblemHint({ contacted_at: null, notify_problem: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" })).toBeNull();
  });
});

describe("isOutdatedCopiesCapped", () => {
  it("is false below the PostgREST cap", () => {
    expect(isOutdatedCopiesCapped(999)).toBe(false);
  });
  it("is true at and past the cap", () => {
    expect(isOutdatedCopiesCapped(1000)).toBe(true);
    expect(isOutdatedCopiesCapped(1001)).toBe(true);
  });
});

describe("cappedCountLabel", () => {
  it("is the exact count when not capped", () => {
    expect(cappedCountLabel(42, false)).toBe(42);
  });
  it("is '1000+' when capped, regardless of the counted length", () => {
    expect(cappedCountLabel(1000, true)).toBe("1000+");
  });
});

describe("outdatedCopyChip", () => {
  it("is null when followed up or not out of date", () => {
    expect(outdatedCopyChip({ ...base, followed_up: true })).toBeNull();
    expect(outdatedCopyChip({ ...base, portal_outdated: false })).toBeNull();
  });
  it("words the copy kind", () => {
    expect(outdatedCopyChip(base)).toBe("Patient has an older copy (portal download)");
    expect(outdatedCopyChip({ ...base, portal_outdated: false, printed_outdated: true }))
      .toBe("Patient has an older copy (printed) — reprint before handing over");
  });
});
