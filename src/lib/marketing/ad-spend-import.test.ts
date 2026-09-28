import { describe, expect, it } from "vitest";
import { describeAdSpendSave, locateHeader, parseAdSpendCsv, parseDateCell } from "./ad-spend-import";

const meta = (rows: Record<string, string>[]) =>
  parseAdSpendCsv(rows, Object.keys(rows[0] ?? {}));

describe("parseDateCell", () => {
  it("reads ISO, slash and month-name dates", () => {
    expect(parseDateCell("2026-09-01")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-09-01 00:00:00")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("9/1/2026")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("25/9/2026")).toEqual({ ok: true, date: "2026-09-25" });
    expect(parseDateCell("Sep 1, 2026")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("1 September 2026")).toEqual({ ok: true, date: "2026-09-01" });
  });
  it("rejects ranges with different ends and impossible dates", () => {
    expect(parseDateCell("2026-09-01 - 2026-09-30")).toEqual({ ok: false, reason: "date_range" });
    expect(parseDateCell("2026-09-01 - 2026-09-01")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-02-30")).toEqual({ ok: false, reason: "bad_date" });
    expect(parseDateCell("MAX")).toEqual({ ok: false, reason: "bad_date" });
  });
});

describe("locateHeader", () => {
  it("skips a BOM and Google's title lines", () => {
    const text = "﻿Campaign report\nSeptember 1, 2026 - September 30, 2026\nDay,Campaign,Cost,Impr.,Clicks,Currency code\n2026-09-01,Brand,100.00,10,1,PHP\n";
    expect(locateHeader(text).startsWith("Day,Campaign,Cost")).toBe(true);
  });
});

describe("parseAdSpendCsv", () => {
  it("reads a Meta daily export per ad, summing duplicates", () => {
    const r = meta([
      { "Day": "2026-09-01", "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Beat_the_Hospital-Price", "Ad name": "Video A", "Ad ID": "123", "Amount spent (PHP)": "1,000.50", "Impressions": "900", "Link clicks": "12" },
      { "Day": "2026-09-01", "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Beat_the_Hospital-Price", "Ad name": "Video A", "Ad ID": "123", "Amount spent (PHP)": "10", "Impressions": "100", "Link clicks": "1" },
    ]);
    expect(r).toMatchObject({ ok: true, currencyAssumed: false, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([{
      spend_date: "2026-09-01", platform: "meta", campaign_key: "beat the hospital price",
      ad_key: "id:123", campaign_label: "Beat_the_Hospital-Price", spend_php: 1010.5, impressions: 1000, clicks: 13,
    }]);
  });
  it("rejects Meta rows that cover a range (no daily breakdown)", () => {
    const r = meta([{ "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-30", "Campaign name": "C", "Amount spent (PHP)": "50" }]);
    expect(r).toMatchObject({ ok: true, rows: [], rejected: [{ reason: "date_range", count: 1 }] });
  });
  it("refuses a Meta file in another currency", () => {
    expect(meta([{ "Day": "2026-09-01", "Campaign name": "C", "Amount spent (USD)": "5" }]))
      .toEqual({ ok: false, error: expect.stringMatching(/USD/) });
  });
  it("reads a Google export, keys by campaign, ignores Total rows", () => {
    const r = parseAdSpendCsv(
      [
        { "Day": "2026-09-01", "Campaign": "Search - Lab", "Cost": "250", "Impr.": "40", "Clicks": "4", "Currency code": "PHP" },
        { "Day": "", "Campaign": "Total: Account", "Cost": "250", "Impr.": "40", "Clicks": "4", "Currency code": "PHP" },
      ],
      ["Day", "Campaign", "Cost", "Impr.", "Clicks", "Currency code"],
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([{
      spend_date: "2026-09-01", platform: "google", campaign_key: "search lab", ad_key: "(campaign)",
      campaign_label: "Search - Lab", spend_php: 250, impressions: 40, clicks: 4,
    }]);
  });
  it("refuses a non-PHP currency column", () => {
    expect(parseAdSpendCsv([{ Day: "2026-09-01", Campaign: "C", Cost: "1", "Currency code": "USD" }], ["Day", "Campaign", "Cost", "Currency code"]))
      .toEqual({ ok: false, error: expect.stringMatching(/USD/) });
  });
  it("reads the Ad Performance template (Platform column) and assumes pesos", () => {
    const r = parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "A", Spend: "10" },
        { Date: "2026-09-01", Platform: "Google Ads", Campaign: "D", "Ad name": "", Spend: "5" },
      ],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(r).toMatchObject({ ok: true, currencyAssumed: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => [x.platform, x.ad_key])).toEqual([["meta", "a"], ["google", "(campaign)"]]);
  });
  it("refuses the whole file when any row is not Meta or Google (spec §2.2)", () => {
    expect(parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", Spend: "10" },
        { Date: "2026-09-01", Platform: "TikTok", Campaign: "C", Spend: "10" },
      ],
      ["Date", "Platform", "Campaign", "Spend"],
    )).toEqual({ ok: false, error: expect.stringMatching(/TikTok/) });
  });
  it("refuses a file with no spend column instead of saving zeros", () => {
    expect(parseAdSpendCsv(
      [{ "Day": "2026-09-01", "Campaign name": "C", "Reporting starts": "2026-09-01", "Impressions": "900" }],
      ["Day", "Campaign name", "Reporting starts", "Impressions"],
    )).toEqual({ ok: false, error: expect.stringMatching(/spend column/) });
  });
  it("keeps an explicit zero (a correction) but rejects a blank spend cell", () => {
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "C", Cost: "0", "Impr.": "0", Clicks: "0" },
        { Day: "2026-09-02", Campaign: "C", Cost: "", "Impr.": "40", Clicks: "4" },
      ],
      ["Day", "Campaign", "Cost", "Impr.", "Clicks"],
    );
    expect(r).toMatchObject({ ok: true, rejected: [{ reason: "bad_spend", count: 1 }] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ spend_date: "2026-09-01", spend_php: 0 })]);
  });
  it("refuses a file with no date column at all, instead of one bad_date rejection per row", () => {
    expect(parseAdSpendCsv([{ Campaign: "C", Cost: "5" }], ["Campaign", "Cost"]))
      .toEqual({ ok: false, error: expect.stringMatching(/date column/) });
  });
  it("refuses a file that is neither Meta nor Google", () => {
    expect(parseAdSpendCsv([{ a: "1" }], ["a"])).toEqual({ ok: false, error: expect.stringMatching(/Meta or Google/) });
  });
  it("rejects negative or unreadable spend and missing campaigns", () => {
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "C", Cost: "-5" },
        { Day: "2026-09-01", Campaign: "", Cost: "5" },
        { Day: "2026-09-01", Campaign: "C", Cost: "abc" },
      ],
      ["Day", "Campaign", "Cost"],
    );
    expect(r).toMatchObject({ ok: true, rows: [], rejected: expect.arrayContaining([
      { reason: "bad_spend", count: 2 }, { reason: "no_campaign", count: 1 },
    ]) });
  });
});

describe("describeAdSpendSave", () => {
  it("words a save and a failure", () => {
    expect(describeAdSpendSave({ ok: true, data: { inserted: 3, replaced: 1, days: 2, currencyAssumed: true,
      rejected: [{ reason: "covers more than one day — export with a 1-day breakdown", count: 4 }] } }))
      .toBe("Saved to clinic records: 2 days, 4 rows rejected (4 covers more than one day — export with a 1-day breakdown). No currency column — pesos assumed.");
    expect(describeAdSpendSave({ ok: false, error: "The file is empty." })).toBe("Not saved to clinic records: The file is empty.");
  });
});
