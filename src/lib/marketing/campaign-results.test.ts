import { describe, expect, it } from "vitest";
import {
  buildDailyCampaignCounts,
  filterDailyCampaignCountsByRange,
  joinCampaignResults,
  normaliseCampaignName,
  NO_CAMPAIGN_LABEL,
  type CampaignResultAppointmentRow,
  type CampaignResultMessageRow,
} from "./campaign-results";

function apptRow(overrides: Partial<CampaignResultAppointmentRow> = {}): CampaignResultAppointmentRow {
  return {
    id: "a1",
    booking_group_id: "g1",
    status: "confirmed",
    attribution: null,
    created_at: "2026-09-01T02:00:00Z", // 10:00 Manila
    ...overrides,
  };
}

function msgRow(overrides: Partial<CampaignResultMessageRow> = {}): CampaignResultMessageRow {
  return {
    id: "m1",
    kind: "general",
    status: "new",
    attribution: null,
    created_at: "2026-09-01T02:00:00Z",
    ...overrides,
  };
}

const CAMPAIGN_ATTR = { utm_campaign: "Beat the Hospital Price" };
const OTHER_CAMPAIGN_ATTR = { utm_campaign: "Corporate Health Partner" };

describe("buildDailyCampaignCounts", () => {
  it("folds multiple rows sharing a booking_group_id into one booking", () => {
    const counts = buildDailyCampaignCounts(
      [
        apptRow({ id: "a1", booking_group_id: "g1", attribution: CAMPAIGN_ATTR }),
        apptRow({ id: "a2", booking_group_id: "g1", attribution: CAMPAIGN_ATTR }),
      ],
      [],
    );
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ bookings: 1, cancelledBookings: 0 });
  });

  it("excludes a booking group from `bookings` only when EVERY row is cancelled/no_show", () => {
    const partiallyCancelled = buildDailyCampaignCounts(
      [
        apptRow({ id: "a1", booking_group_id: "g1", status: "cancelled", attribution: CAMPAIGN_ATTR }),
        apptRow({ id: "a2", booking_group_id: "g1", status: "confirmed", attribution: CAMPAIGN_ATTR }),
      ],
      [],
    );
    expect(partiallyCancelled[0]).toMatchObject({ bookings: 1, cancelledBookings: 0 });

    const fullyCancelled = buildDailyCampaignCounts(
      [
        apptRow({ id: "b1", booking_group_id: "g2", status: "cancelled", attribution: CAMPAIGN_ATTR }),
        apptRow({ id: "b2", booking_group_id: "g2", status: "no_show", attribution: CAMPAIGN_ATTR }),
      ],
      [],
    );
    expect(fullyCancelled[0]).toMatchObject({ bookings: 0, cancelledBookings: 1 });
  });

  it("buckets the Manila day an instant falls on, not the UTC day", () => {
    // 16:30 UTC = 00:30 the NEXT day in Manila (+08:00).
    const counts = buildDailyCampaignCounts(
      [apptRow({ id: "a1", booking_group_id: "g1", created_at: "2026-09-01T16:30:00Z", attribution: CAMPAIGN_ATTR })],
      [],
    );
    expect(counts[0]!.date).toBe("2026-09-02");
  });

  it("buckets an instant just before the Manila boundary on the same day", () => {
    // 15:59 UTC = 23:59 Manila, still the 1st.
    const counts = buildDailyCampaignCounts(
      [apptRow({ id: "a1", booking_group_id: "g1", created_at: "2026-09-01T15:59:00Z", attribution: CAMPAIGN_ATTR })],
      [],
    );
    expect(counts[0]!.date).toBe("2026-09-01");
  });

  it("uses NO_CAMPAIGN_LABEL for rows with no usable utm_campaign", () => {
    const counts = buildDailyCampaignCounts([apptRow({ attribution: null })], []);
    expect(counts[0]!.campaign).toBe(NO_CAMPAIGN_LABEL);
  });

  it("counts website messages and their corporate subset separately from bookings", () => {
    const counts = buildDailyCampaignCounts(
      [],
      [
        msgRow({ id: "m1", kind: "general", attribution: CAMPAIGN_ATTR }),
        msgRow({ id: "m2", kind: "corporate", attribution: CAMPAIGN_ATTR }),
      ],
    );
    expect(counts[0]).toMatchObject({ messages: 2, corporateMessages: 1, bookings: 0 });
  });

  it("keeps separate buckets per (date, campaign) pair", () => {
    const counts = buildDailyCampaignCounts(
      [
        apptRow({ id: "a1", booking_group_id: "g1", created_at: "2026-09-01T02:00:00Z", attribution: CAMPAIGN_ATTR }),
        apptRow({
          id: "a2",
          booking_group_id: "g2",
          created_at: "2026-09-01T02:00:00Z",
          attribution: OTHER_CAMPAIGN_ATTR,
        }),
        apptRow({ id: "a3", booking_group_id: "g3", created_at: "2026-09-02T02:00:00Z", attribution: CAMPAIGN_ATTR }),
      ],
      [],
    );
    expect(counts).toHaveLength(3);
  });
});

describe("filterDailyCampaignCountsByRange", () => {
  const counts = buildDailyCampaignCounts(
    [
      apptRow({ id: "a1", booking_group_id: "g1", created_at: "2026-08-31T02:00:00Z", attribution: CAMPAIGN_ATTR }),
      apptRow({ id: "a2", booking_group_id: "g2", created_at: "2026-09-01T02:00:00Z", attribution: CAMPAIGN_ATTR }),
      apptRow({ id: "a3", booking_group_id: "g3", created_at: "2026-09-05T02:00:00Z", attribution: CAMPAIGN_ATTR }),
    ],
    [],
  );

  it("keeps only buckets within the inclusive range", () => {
    const filtered = filterDailyCampaignCountsByRange(counts, "2026-09-01", "2026-09-05");
    expect(filtered.map((c) => c.date)).toEqual(["2026-09-01", "2026-09-05"]);
  });

  it("returns nothing for a range outside every bucket", () => {
    expect(filterDailyCampaignCountsByRange(counts, "2026-10-01", "2026-10-31")).toEqual([]);
  });
});

describe("normaliseCampaignName", () => {
  it("lowercases and trims", () => {
    expect(normaliseCampaignName("  Beat the Hospital Price  ")).toBe("beat the hospital price");
  });

  it("collapses underscores, hyphens, dots and repeated whitespace to single spaces", () => {
    expect(normaliseCampaignName("Beat_the-Hospital.Price")).toBe("beat the hospital price");
    expect(normaliseCampaignName("Beat   the    Price")).toBe("beat the price");
    expect(normaliseCampaignName("--Beat--Price--")).toBe("beat price");
  });

  it("treats mixed-punctuation spellings of the same campaign as equal", () => {
    expect(normaliseCampaignName("Beat_the_Hospital_Price")).toBe(
      normaliseCampaignName("Beat the Hospital Price."),
    );
  });
});

describe("joinCampaignResults", () => {
  it("matches a clinic campaign to an ad campaign by normalised name and computes cost per booking", () => {
    const result = joinCampaignResults(
      [
        { date: "2026-09-01", campaign: "Beat the Hospital Price", bookings: 4, cancelledBookings: 1, messages: 2, corporateMessages: 0 },
      ],
      [{ campaign: "Beat_the_Hospital_Price", spend: 4000 }],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({
      campaign: "Beat_the_Hospital_Price",
      spend: 4000,
      bookings: 4,
      cancelledBookings: 1,
      messages: 2,
      costPerBooking: 1000,
    });
    expect(result.totals).toMatchObject({ spend: 4000, bookings: 4, costPerBooking: 1000 });
    expect(result.unmatchedAdCampaigns).toEqual([]);
    expect(result.unmatchedClinicCampaigns).toEqual([]);
  });

  it("reports costPerBooking as null, never Infinity or NaN, when a matched campaign has zero bookings", () => {
    const result = joinCampaignResults(
      [],
      [{ campaign: "Specialist Spotlight", spend: 500 }],
    );
    expect(result.matched[0]!.costPerBooking).toBeNull();
    expect(result.totals.costPerBooking).toBeNull();
  });

  it("lists an ad campaign with spend but no tagged bookings/messages as unmatched", () => {
    const result = joinCampaignResults([], [{ campaign: "Results Tomorrow", spend: 300 }]);
    expect(result.unmatchedAdCampaigns).toEqual(["Results Tomorrow"]);
    expect(result.matched[0]!.bookings).toBe(0);
  });

  it("lists a clinic UTM campaign with bookings but no uploaded ad campaign as unmatched", () => {
    const result = joinCampaignResults(
      [{ date: "2026-09-01", campaign: "Specialist Spotlight", bookings: 2, cancelledBookings: 0, messages: 0, corporateMessages: 0 }],
      [],
    );
    expect(result.unmatchedClinicCampaigns).toEqual(["Specialist Spotlight"]);
    expect(result.matched).toEqual([]);
  });

  it("never lists NO_CAMPAIGN_LABEL as an unmatched clinic campaign", () => {
    const result = joinCampaignResults(
      [{ date: "2026-09-01", campaign: NO_CAMPAIGN_LABEL, bookings: 5, cancelledBookings: 0, messages: 1, corporateMessages: 0 }],
      [],
    );
    expect(result.unmatchedClinicCampaigns).toEqual([]);
  });

  it("sums multiple matched campaigns into totals and sorts matched rows by spend descending", () => {
    const result = joinCampaignResults(
      [
        { date: "2026-09-01", campaign: "Small Campaign", bookings: 1, cancelledBookings: 0, messages: 0, corporateMessages: 0 },
        { date: "2026-09-01", campaign: "Big Campaign", bookings: 2, cancelledBookings: 0, messages: 0, corporateMessages: 0 },
      ],
      [
        { campaign: "Small Campaign", spend: 100 },
        { campaign: "Big Campaign", spend: 900 },
      ],
    );
    expect(result.matched.map((m) => m.campaign)).toEqual(["Big Campaign", "Small Campaign"]);
    expect(result.totals).toMatchObject({ spend: 1000, bookings: 3 });
  });
});
