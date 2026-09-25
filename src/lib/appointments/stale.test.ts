import { describe, expect, it } from "vitest";
import {
  REMIND_UNTIMED_AFTER_DAYS,
  STALE_UNTIMED_AFTER_DAYS,
  bookingAgeDays,
  bookingAgeLabel,
  countLikelyNoShowBookings,
  groupBookingRows,
  isStaleUntimedBooking,
  staleCutoffIso,
  splitBookingsByActivePatient,
  unactedBookings,
} from "./stale";

const TODAY = "2026-09-25";

describe("bookingAgeDays", () => {
  it("counts Manila calendar days, not 24-hour periods", () => {
    // 23:50 Manila on the 24th is 15:50 UTC — one calendar day before the 25th.
    expect(bookingAgeDays("2026-09-24T15:50:00Z", TODAY)).toBe(1);
    // 00:10 Manila on the 25th is 16:10 UTC on the 24th — still today in Manila.
    expect(bookingAgeDays("2026-09-24T16:10:00Z", TODAY)).toBe(0);
  });

  it("counts across months", () => {
    expect(bookingAgeDays("2026-06-16T02:00:00Z", TODAY)).toBe(101);
  });

  it("never goes negative for a timestamp after today", () => {
    expect(bookingAgeDays("2026-09-26T02:00:00Z", TODAY)).toBe(0);
  });
});

describe("bookingAgeLabel", () => {
  it("reads naturally for today, yesterday and older", () => {
    expect(bookingAgeLabel(0)).toBe("Booked today");
    expect(bookingAgeLabel(1)).toBe("Booked yesterday");
    expect(bookingAgeLabel(12)).toBe("Booked 12 days ago");
  });
});

describe("isStaleUntimedBooking", () => {
  const old = "2026-09-01T02:00:00Z";

  it("flags an old, untimed, still-confirmed booking", () => {
    expect(isStaleUntimedBooking({ status: "confirmed", scheduled_at: null, created_at: old }, TODAY)).toBe(true);
  });

  it("never flags an arrived booking — the patient is here", () => {
    expect(isStaleUntimedBooking({ status: "arrived", scheduled_at: null, created_at: old }, TODAY)).toBe(false);
  });

  it("never flags a booking with a set time", () => {
    expect(
      isStaleUntimedBooking({ status: "confirmed", scheduled_at: "2026-09-02T01:00:00Z", created_at: old }, TODAY),
    ).toBe(false);
  });

  it("starts flagging exactly at the threshold", () => {
    // Created on the 18th (Manila) = 7 days before the 25th.
    const atThreshold = "2026-09-18T02:00:00Z";
    const dayBefore = "2026-09-19T02:00:00Z";
    expect(STALE_UNTIMED_AFTER_DAYS).toBe(7);
    expect(isStaleUntimedBooking({ status: "confirmed", scheduled_at: null, created_at: atThreshold }, TODAY)).toBe(true);
    expect(isStaleUntimedBooking({ status: "confirmed", scheduled_at: null, created_at: dayBefore }, TODAY)).toBe(false);
  });
});

describe("staleCutoffIso", () => {
  it("is Manila midnight starting the first day that is NOT yet stale", () => {
    // 19 Sep 00:00 +08:00 = 18 Sep 16:00 UTC.
    expect(staleCutoffIso(TODAY)).toBe("2026-09-18T16:00:00.000Z");
  });

  it("agrees with isStaleUntimedBooking on both sides of the boundary", () => {
    const cutoff = staleCutoffIso(TODAY);
    const justBefore = new Date(Date.parse(cutoff) - 1000).toISOString();
    const atCutoff = cutoff;
    const row = (created_at: string) => ({ status: "confirmed", scheduled_at: null, created_at });
    // Database predicate: created_at < cutoff.
    expect(justBefore < cutoff).toBe(true);
    expect(isStaleUntimedBooking(row(justBefore), TODAY)).toBe(true);
    expect(atCutoff < cutoff).toBe(false);
    expect(isStaleUntimedBooking(row(atCutoff), TODAY)).toBe(false);
  });
});

describe("splitBookingsByActivePatient", () => {
  const patientOf = new Map<string, string | null>([
    ["a1", "p-active"],
    ["a2", "p-active"],
    ["b1", "p-merged"],
    ["c1", null], // walk-in, no patient record
  ]);
  const active = new Set(["p-active"]);

  it("restores active-patient and walk-in bookings, holds back an inactive patient's", () => {
    const { restorable, heldBack } = splitBookingsByActivePatient([["a1", "a2"], ["b1"], ["c1"]], patientOf, active);
    expect(restorable).toEqual([["a1", "a2"], ["c1"]]);
    expect(heldBack).toEqual([["b1"]]);
  });

  it("holds back a booking with a row it can no longer find", () => {
    const { restorable, heldBack } = splitBookingsByActivePatient([["a1", "gone"]], patientOf, active);
    expect(restorable).toEqual([]);
    expect(heldBack).toEqual([["a1", "gone"]]);
  });
});

describe("groupBookingRows", () => {
  it("folds a multi-service booking into one group, first-seen order", () => {
    const rows = [
      { id: "a1", booking_group_id: "g1" },
      { id: "b1", booking_group_id: null },
      { id: "a2", booking_group_id: "g1" },
    ];
    expect(groupBookingRows(rows).map((g) => g.map((r) => r.id))).toEqual([["a1", "a2"], ["b1"]]);
  });
});

describe("countLikelyNoShowBookings", () => {
  const OLD = "2026-09-10T02:00:00Z";
  const NEW = "2026-09-24T02:00:00Z";
  const row = (id: string, group: string | null, status: string, created_at: string) => ({
    id,
    booking_group_id: group,
    status,
    scheduled_at: null,
    created_at,
  });

  it("counts bookings, not rows, and judges each by its lead row", () => {
    const rows = [
      row("a1", "g1", "confirmed", OLD),
      row("a2", "g1", "confirmed", OLD),
      row("b1", null, "arrived", OLD),
      row("c1", null, "confirmed", NEW),
      row("d1", "g2", "confirmed", OLD),
    ];
    expect(countLikelyNoShowBookings(rows, TODAY)).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(countLikelyNoShowBookings([], TODAY)).toBe(0);
  });
});

describe("unactedBookings", () => {
  const row = (id: string, group: string | null, status: string, created_at: string) => ({
    id,
    booking_group_id: group,
    status,
    scheduled_at: null,
    created_at,
  });

  it("keeps confirmed bookings at least REMIND_UNTIMED_AFTER_DAYS old, oldest first", () => {
    const rows = [
      row("old", null, "confirmed", "2026-09-10T02:00:00Z"), // 15 days
      row("arr", null, "arrived", "2026-09-11T02:00:00Z"), // acted on
      row("g-a", "g", "confirmed", "2026-09-22T02:00:00Z"), // 3 days
      row("g-b", "g", "confirmed", "2026-09-22T02:00:00Z"),
      row("new", null, "confirmed", "2026-09-23T02:00:00Z"), // 2 days
    ];
    const out = unactedBookings(rows, TODAY);
    expect(REMIND_UNTIMED_AFTER_DAYS).toBe(3);
    expect(out.map((b) => [b.rows.map((r) => r.id), b.ageDays, b.likelyNoShow])).toEqual([
      [["old"], 15, true],
      [["g-a", "g-b"], 3, false],
    ]);
  });
});
