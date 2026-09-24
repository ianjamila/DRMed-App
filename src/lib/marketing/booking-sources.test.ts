import { describe, expect, it } from "vitest";
import {
  groupBookings,
  summarizeBookings,
  summarizeMessages,
  NO_CAMPAIGN_LABEL,
  type AppointmentSourceRow,
  type ContactMessageSourceRow,
} from "./booking-sources";

function apptRow(overrides: Partial<AppointmentSourceRow> = {}): AppointmentSourceRow {
  return {
    id: "a1",
    booking_group_id: "g1",
    source: "phone",
    attribution: null,
    status: "confirmed",
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function msgRow(overrides: Partial<ContactMessageSourceRow> = {}): ContactMessageSourceRow {
  return {
    id: "m1",
    kind: "general",
    status: "new",
    attribution: null,
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("groupBookings", () => {
  it("folds multiple rows sharing a booking_group_id into one group", () => {
    const groups = groupBookings([
      apptRow({ id: "a1", booking_group_id: "g1", status: "confirmed" }),
      apptRow({ id: "a2", booking_group_id: "g1", status: "confirmed" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("g1");
  });

  it("falls back to the row's own id when booking_group_id is null", () => {
    const groups = groupBookings([apptRow({ id: "a1", booking_group_id: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("a1");
  });

  it("preserves insertion order of distinct groups", () => {
    const groups = groupBookings([
      apptRow({ id: "a1", booking_group_id: "g1" }),
      apptRow({ id: "a2", booking_group_id: "g2" }),
      apptRow({ id: "a3", booking_group_id: "g1" }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("treats a null/unrecognised source as 'not recorded' (null)", () => {
    const groups = groupBookings([apptRow({ source: null })]);
    expect(groups[0]!.source).toBeNull();
    const junk = groupBookings([apptRow({ source: "smoke_signal" })]);
    expect(junk[0]!.source).toBeNull();
  });

  it("a group is active unless EVERY row is cancelled or no-show", () => {
    const partiallyCancelled = groupBookings([
      apptRow({ id: "a1", booking_group_id: "g1", status: "cancelled" }),
      apptRow({ id: "a2", booking_group_id: "g1", status: "confirmed" }),
    ]);
    expect(partiallyCancelled[0]!.active).toBe(true);

    const fullyCancelled = groupBookings([
      apptRow({ id: "a1", booking_group_id: "g2", status: "cancelled" }),
      apptRow({ id: "a2", booking_group_id: "g2", status: "no_show" }),
    ]);
    expect(fullyCancelled[0]!.active).toBe(false);
  });

  it("parses stored attribution jsonb back into an Attribution", () => {
    const groups = groupBookings([
      apptRow({ attribution: { utm_campaign: "sept-promo", utm_source: "facebook" } }),
    ]);
    expect(groups[0]!.attribution?.utm_campaign).toBe("sept-promo");
  });

  it("degrades a malformed attribution value to null rather than throwing", () => {
    const groups = groupBookings([apptRow({ attribution: "not an object" })]);
    expect(groups[0]!.attribution).toBeNull();
    const arr = groupBookings([apptRow({ attribution: ["nope"] })]);
    expect(arr[0]!.attribution).toBeNull();
  });
});

describe("summarizeBookings", () => {
  it("counts cancelled/no-show groups separately from the total and by-source tables", () => {
    const stats = summarizeBookings([
      apptRow({ id: "a1", booking_group_id: "g1", source: "phone", status: "confirmed" }),
      apptRow({ id: "a2", booking_group_id: "g2", source: "walk_in", status: "cancelled" }),
    ]);
    expect(stats.totalBookingGroups).toBe(2);
    expect(stats.activeBookingGroups).toBe(1);
    expect(stats.cancelledOrNoShowBookingGroups).toBe(1);
    // The cancelled group's source does not appear in bySource's counts.
    const walkIn = stats.bySource.find((s) => s.source === "walk_in");
    expect(walkIn?.count).toBe(0);
    const phone = stats.bySource.find((s) => s.source === "phone");
    expect(phone?.count).toBe(1);
  });

  it("keeps every APPOINTMENT_SOURCE plus 'Not recorded' as a zero row when absent", () => {
    const stats = summarizeBookings([apptRow({ source: "phone" })]);
    expect(stats.bySource.length).toBeGreaterThan(1);
    const referral = stats.bySource.find((s) => s.source === "referral");
    expect(referral).toBeDefined();
    expect(referral?.count).toBe(0);
    const notRecorded = stats.bySource.find((s) => s.source === null);
    expect(notRecorded?.label).toBe("Not recorded");
    expect(notRecorded?.count).toBe(0);
  });

  it("groups by campaign label, falling back to the no-ad-tag label", () => {
    const stats = summarizeBookings([
      apptRow({ id: "a1", booking_group_id: "g1", attribution: { utm_campaign: "sept-promo" } }),
      apptRow({ id: "a2", booking_group_id: "g2", attribution: null }),
    ]);
    const named = stats.byCampaign.find((c) => c.label === "sept-promo");
    expect(named?.count).toBe(1);
    const direct = stats.byCampaign.find((c) => c.label === NO_CAMPAIGN_LABEL);
    expect(direct?.count).toBe(1);
  });

  it("sorts byCampaign by count desc, then label for ties", () => {
    const stats = summarizeBookings([
      apptRow({ id: "a1", booking_group_id: "g1", attribution: { utm_campaign: "zeta" } }),
      apptRow({ id: "a2", booking_group_id: "g2", attribution: { utm_campaign: "alpha" } }),
      apptRow({ id: "a3", booking_group_id: "g3", attribution: { utm_campaign: "alpha" } }),
    ]);
    expect(stats.byCampaign.map((c) => c.label)).toEqual(["alpha", "zeta"]);
  });

  it("returns zero-filled stats for an empty period", () => {
    const stats = summarizeBookings([]);
    expect(stats.totalBookingGroups).toBe(0);
    expect(stats.activeBookingGroups).toBe(0);
    expect(stats.cancelledOrNoShowBookingGroups).toBe(0);
    expect(stats.byCampaign).toEqual([]);
    expect(stats.bySource.every((s) => s.count === 0)).toBe(true);
  });
});

describe("summarizeMessages", () => {
  it("guards the booked rate against divide-by-zero", () => {
    expect(summarizeMessages([]).bookedRate).toBeNull();
  });

  it("computes booked / total", () => {
    const stats = summarizeMessages([
      msgRow({ id: "m1", status: "booked" }),
      msgRow({ id: "m2", status: "new" }),
      msgRow({ id: "m3", status: "closed" }),
      msgRow({ id: "m4", status: "replied" }),
    ]);
    expect(stats.total).toBe(4);
    expect(stats.bookedCount).toBe(1);
    expect(stats.bookedRate).toBe(0.25);
  });

  it("keeps every kind/status as a zero row when absent from the period", () => {
    const stats = summarizeMessages([msgRow({ kind: "general", status: "new" })]);
    const corporate = stats.byKind.find((k) => k.kind === "corporate");
    expect(corporate?.count).toBe(0);
    const booked = stats.byStatus.find((s) => s.status === "booked");
    expect(booked?.count).toBe(0);
  });

  it("treats an unrecognised kind/status as the safe default rather than dropping the row", () => {
    const stats = summarizeMessages([msgRow({ kind: "smoke_signal", status: "ghosted" })]);
    expect(stats.total).toBe(1);
    const general = stats.byKind.find((k) => k.kind === "general");
    expect(general?.count).toBe(1);
    const brandNew = stats.byStatus.find((s) => s.status === "new");
    expect(brandNew?.count).toBe(1);
  });

  it("groups messages by campaign label", () => {
    const stats = summarizeMessages([
      msgRow({ id: "m1", attribution: { utm_source: "facebook", utm_medium: "cpc" } }),
      msgRow({ id: "m2", attribution: null }),
    ]);
    expect(stats.byCampaign.find((c) => c.label === "facebook / cpc")?.count).toBe(1);
    expect(stats.byCampaign.find((c) => c.label === NO_CAMPAIGN_LABEL)?.count).toBe(1);
  });
});
