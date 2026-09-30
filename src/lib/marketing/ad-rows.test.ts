import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { parseAdSpendText } from "./ad-spend-import";
import { adWindow, hasUnknownFunnel, legacyRowsToCsv, savedRowsToAdRows, type AdRow } from "./ad-rows";
import type { AdSpendDbRow } from "./patient-sources";

const db = (over: Partial<AdSpendDbRow> = {}): AdSpendDbRow => ({
  spend_date: "2026-09-01", platform: "meta", campaign_key: "beat the hospital price", campaign_label: "Beat the Hospital Price",
  ad_key: "price vs hospital", ad_label: "Price vs Hospital", spend_php: 300, impressions: 17600, clicks: 300, leads: 48, platform_bookings: 29, ...over,
});

describe("adWindow", () => {
  it("is null with nothing saved", () => expect(adWindow([])).toBeNull());
  it("spans all saved coverage across both platforms", () => {
    expect(adWindow([{ first_date: "2026-08-01", last_date: "2026-09-10" }, { first_date: "2026-07-15", last_date: "2026-09-20" }]))
      .toEqual({ from: "2026-07-15", to: "2026-09-20", cutOff: false, coverageFrom: "2026-07-15", coverageTo: "2026-09-20" });
  });
  it("loads exactly the latest 400 days when coverage is longer, and says so", () => {
    const w = adWindow([{ first_date: "2024-01-01", last_date: "2026-09-30" }])!;
    expect(w).toMatchObject({ from: "2025-08-26", to: "2026-09-30", cutOff: true, coverageFrom: "2024-01-01" });
  });
  it("does not cut a coverage of exactly 400 days", () => {
    expect(adWindow([{ first_date: "2025-08-26", last_date: "2026-09-30" }])).toMatchObject({ from: "2025-08-26", cutOff: false });
  });
});

describe("savedRowsToAdRows", () => {
  it("maps a saved row to the dashboard's row", () => {
    expect(savedRowsToAdRows([db()])).toEqual([
      { date: "2026-09-01", platform: "Meta", campaign: "Beat the Hospital Price", ad: "Price vs Hospital", spend: 300, impressions: 17600, clicks: 300, leads: 48, bookings: 29 },
    ]);
  });
  it("counts unknown figures as 0 and names a campaign-total and an id-only row sensibly", () => {
    const rows = savedRowsToAdRows([
      db({ ad_key: "(campaign)", ad_label: null, impressions: null, clicks: null, leads: null, platform_bookings: null }),
      db({ ad_key: "id:123", ad_label: null, spend_date: "2026-09-02" }),
      db({ platform: "google", ad_key: "rsa a", ad_label: null, spend_date: "2026-09-03" }),
    ]);
    expect(rows[0]).toMatchObject({ ad: "—", impressions: 0, clicks: 0, leads: 0, bookings: 0 });
    expect(rows[1]!.ad).toBe("Ad 123");
    expect(rows[2]).toMatchObject({ platform: "Google", ad: "rsa a" });
  });
  it("shows a campaign under its most recent label on every day", () => {
    const rows = savedRowsToAdRows([
      db({ spend_date: "2026-09-01", campaign_label: "Beat_the_Hospital-Price" }),
      db({ spend_date: "2026-09-02", campaign_label: "Beat the Hospital Price" }),
    ]);
    expect(new Set(rows.map((r) => r.campaign))).toEqual(new Set(["Beat the Hospital Price"]));
  });
  it("flags rows whose funnel figures are unknown", () => {
    expect(hasUnknownFunnel([db()])).toBe(false);
    expect(hasUnknownFunnel([db(), db({ leads: null })])).toBe(true);
    expect(hasUnknownFunnel([db({ platform_bookings: null })])).toBe(true);
  });
});

describe("legacyRowsToCsv", () => {
  const r = (over: Partial<AdRow> = {}): AdRow => ({
    date: "2026-06-15", platform: "Meta", campaign: "Beat the Hospital Price", ad: "Price vs Hospital", spend: 300, impressions: 17600, clicks: 300, leads: 48, bookings: 29, ...over,
  });
  it("round-trips through the SERVER parser with every figure intact", () => {
    const { csv, rows } = legacyRowsToCsv([r(), r({ platform: "Google", ad: 'PEME, "RSA"', campaign: "Corp, Health", spend: 320.5 })]);
    expect(rows).toBe(2);
    const parsed = parseAdSpendText(csv);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows).toEqual([
      expect.objectContaining({ platform: "meta", campaign_label: "Beat the Hospital Price", ad_label: "Price vs Hospital", spend_php: 300, impressions: 17600, clicks: 300, leads: 48, platform_bookings: 29 }),
      expect.objectContaining({ platform: "google", campaign_label: "Corp, Health", ad_label: 'PEME, "RSA"', spend_php: 320.5 }),
    ]);
  });
  it("leaves out platforms the server refuses, and counts them", () => {
    const out = legacyRowsToCsv([r(), r({ platform: "Other" })]);
    expect(out).toMatchObject({ rows: 1, skippedOtherPlatform: 1 });
    expect(Papa.parse(out.csv, { header: true, skipEmptyLines: true }).data).toHaveLength(1);
  });
  it("saves nameless ads as a campaign total, but never mixes a total with named ads in one campaign-day", () => {
    const allNameless = legacyRowsToCsv([r({ ad: "—" })]);
    const p1 = parseAdSpendText(allNameless.csv);
    if (!p1.ok) throw new Error(p1.error);
    expect(p1.rows[0]!.ad_key).toBe("(campaign)");
    const mixed = legacyRowsToCsv([r({ ad: "—" }), r({ ad: "Real ad" })]);
    const p2 = parseAdSpendText(mixed.csv);
    if (!p2.ok) throw new Error(p2.error);
    expect(p2.rows.map((x) => x.ad_key).sort()).toEqual(["real ad", "unnamed ad"]);
  });
});
