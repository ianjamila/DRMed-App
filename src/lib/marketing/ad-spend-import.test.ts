import { describe, expect, it } from "vitest";
import { describeAdSpendSave, locateHeader, parseAdSpendCsv, parseAdSpendText, parseDateCell } from "./ad-spend-import";

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
  it("rejects an 'A to B' range in one cell as date_range, not a silent first-day truncation (Codex #3)", () => {
    expect(parseDateCell("2026-09-01 to 2026-09-30")).toEqual({ ok: false, reason: "date_range" });
    expect(parseDateCell("2026-09-01 to 2026-09-01")).toEqual({ ok: true, date: "2026-09-01" });
  });
  it("rejects unrecognised trailing text after an ISO date instead of silently dropping it (Codex #3)", () => {
    expect(parseDateCell("2026-09-01 something else")).toEqual({ ok: false, reason: "bad_date" });
    expect(parseDateCell("2026-09-01 00:00 something else")).toEqual({ ok: false, reason: "bad_date" });
  });
  it("still accepts real timestamp suffixes on an ISO date", () => {
    expect(parseDateCell("2026-09-01T00:00:00")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-09-01 00:00:00.123")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-09-01T00:00:00+08:00")).toEqual({ ok: true, date: "2026-09-01" });
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
  it("rejects a campaign name that normalises to empty (Sonnet review #3)", () => {
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "---", Cost: "5" },
        { Day: "2026-09-01", Campaign: "___", Cost: "5" },
        { Day: "2026-09-01", Campaign: "C", Cost: "5" },
      ],
      ["Day", "Campaign", "Cost"],
    );
    expect(r).toMatchObject({ ok: true, rejected: [{ reason: "no_campaign", count: 2 }] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ campaign_key: "c" })]);
  });
  it("rejects rows PapaParse flagged as malformed (extra/missing columns), never saving their value (Codex #2)", () => {
    // "Day,Campaign,Cost" header; row 1 has an extra unquoted comma inside the
    // amount ("1,234.50"), which PapaParse reports as a TooManyFields error at
    // row index 0 — the amount must never be silently read as "1".
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "Brand", Cost: "1" },
        { Day: "2026-09-02", Campaign: "Brand", Cost: "50" },
      ],
      ["Day", "Campaign", "Cost"],
      new Set([0]),
    );
    expect(r).toMatchObject({ ok: true, rejected: [{ reason: "malformed_row", count: 1 }] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ spend_date: "2026-09-02", spend_php: 50 })]);
  });
  it("refuses a file that mixes a campaign-total row with per-ad rows for the same campaign and day (Codex #1)", () => {
    const r = parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "", Spend: "100" },
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "Video A", Spend: "60" },
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "Video B", Spend: "40" },
      ],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/mixes more than one ad-spend breakdown/) });
  });
  it("refuses a file that mixes per-ad-by-name and per-ad-by-ID rows for the same campaign and day (Codex recheck #1, parser half)", () => {
    const r = parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "Video A", "Ad ID": "", Spend: "60" },
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "", "Ad ID": "123", Spend: "40" },
      ],
      ["Date", "Platform", "Campaign", "Ad name", "Ad ID", "Spend"],
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/mixes more than one ad-spend breakdown/) });
  });
  it("allows per-ad rows alone, and campaign-total rows alone, for the same campaign/day", () => {
    const perAd = parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "Video A", Spend: "60" },
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "Video B", Spend: "40" },
      ],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(perAd).toMatchObject({ ok: true, rejected: [] });
    const total = parseAdSpendCsv(
      [{ Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "", Spend: "100" }],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(total).toMatchObject({ ok: true, rejected: [] });
  });
});

describe("summary rows vs real campaigns named Total… (Codex C2)", () => {
  const H = ["Day", "Campaign", "Cost", "Currency code"];
  const row = (day: string, campaign: string, cost = "100") => ({ Day: day, Campaign: campaign, Cost: cost, "Currency code": "PHP" });

  it("keeps a real campaign named 'Total Health' that has a date", () => {
    const r = parseAdSpendCsv([row("2026-09-01", "Total Health", "300"), row("", "Total: Account", "300")], H);
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ campaign_key: "total health", campaign_label: "Total Health", spend_php: 300 })]);
  });
  it("still skips the export's own summary rows (Total: … / Total in the date column / a bare Total with no date)", () => {
    const r = parseAdSpendCsv(
      [row("2026-09-01", "Brand"), row("", "Total: Account"), row("Total: Campaigns", "--"), row("", "Total"), row("", "total : search")],
      H,
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => x.campaign_key)).toEqual(["brand"]);
  });
  it("REJECTS visibly (never skips) an ambiguous 'Total Health' row with no date", () => {
    const r = parseAdSpendCsv([row("2026-09-01", "Brand"), row("", "Total Health", "999")], H);
    expect(r).toMatchObject({ ok: true, rejected: [{ reason: "bad_date", count: 1 }] });
  });
  it("reads a Meta export the same way (Reporting starts/ends)", () => {
    const cols = ["Reporting starts", "Reporting ends", "Campaign name", "Amount spent (PHP)"];
    const r = parseAdSpendCsv(
      [
        { "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Total Health Check-up", "Amount spent (PHP)": "50" },
        { "Reporting starts": "", "Reporting ends": "", "Campaign name": "Total", "Amount spent (PHP)": "50" },
      ],
      cols,
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toHaveLength(1);
  });
});

describe("row keys cannot collide on a '|' inside a name (Codex C1)", () => {
  it("keeps campaign 'C|D' + ad 'E' and campaign 'C' + ad 'D|E' as two rows with their own amounts", () => {
    const raw = (campaign: string, ad: string, spend: string) => ({ Date: "2026-09-01", Platform: "Facebook", Campaign: campaign, "Ad name": ad, Spend: spend });
    const r = parseAdSpendCsv(
      [raw("C|D", "E", "10"), raw("C", "D|E", "20")],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.spend_php).sort()).toEqual([10, 20]);
  });
});

describe("parseAdSpendText (through real PapaParse — Codex recheck #2)", () => {
  it("refuses the whole file on an unterminated quote (Quotes-type error), never keeping the merged record", () => {
    // Codex's exact probe: PapaParse swallows the rest of the file into the
    // Cost field's value instead of erroring on the specific row, so the
    // error's `row` index does not point at a usable record — the previous
    // fix (mapping every error's `row` into parsed.data) accepted this as a
    // clean ₱100 row with no rejection.
    const text = 'Day,Campaign,Cost\n2026-09-01,Brand,"100\n2026-09-02,Brand,50\n';
    expect(parseAdSpendText(text)).toEqual({
      ok: false,
      error: expect.stringMatching(/broken quote/),
    });
  });
  it("refuses the whole file on an InvalidQuotes error the same way", () => {
    // A quoted field with trailing text before its delimiter ("Brand"x,50) —
    // PapaParse reports InvalidQuotes (plus a cascading MissingQuotes and
    // TooFewFields on the same mangled row).
    const text = 'Day,Campaign,Cost\n2026-09-01,"Brand"x,50\n';
    const r = parseAdSpendText(text);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/broken quote/) });
  });
  it("still rejects only the row with an unquoted comma as malformed_row, keeping the other row (regression)", () => {
    const text = "Day,Campaign,Cost\n2026-09-01,Brand,1,234.50\n2026-09-02,Brand,50\n";
    const r = parseAdSpendText(text);
    expect(r).toMatchObject({ ok: true, rejected: [{ reason: "malformed_row", count: 1 }] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ spend_date: "2026-09-02", spend_php: 50 })]);
  });
  it("parses a normal Google export end to end, dropping the title lines and BOM", () => {
    const text = "﻿Campaign report\nSeptember 1, 2026 - September 30, 2026\nDay,Campaign,Cost,Impr.,Clicks,Currency code\n2026-09-01,Search - Lab,250,40,4,PHP\n";
    const r = parseAdSpendText(text);
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([expect.objectContaining({ spend_date: "2026-09-01", campaign_key: "search lab", spend_php: 250 })]);
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
