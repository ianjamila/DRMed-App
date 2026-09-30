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
      ad_label: "Video A",
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
      // no Ad name, Leads or Bookings column: those keys are omitted, not null
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

describe("leads, platform bookings and the ad's display name", () => {
  const hdr = ["platform", "date", "campaign", "ad", "spend", "impressions", "clicks", "leads", "bookings"];
  const tpl = (rows: string[][]) => parseAdSpendCsv(rows.map((v) => Object.fromEntries(hdr.map((k, i) => [k, v[i] ?? ""]))), hdr);

  it("reads the Ad Performance template's leads and bookings and keeps the ad name as uploaded", () => {
    const r = tpl([["Meta", "2026-06-15", "Beat the Hospital Price", "Price vs Hospital", "300", "17600", "300", "48", "29"]]);
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([{
      spend_date: "2026-06-15", platform: "meta", campaign_key: "beat the hospital price", ad_key: "price vs hospital",
      campaign_label: "Beat the Hospital Price", spend_php: 300, impressions: 17600, clicks: 300,
      ad_label: "Price vs Hospital", leads: 48, platform_bookings: 29,
    }]);
  });
  it("keeps a blank cell as unknown (null) and an explicit 0 as a real zero", () => {
    const r = tpl([
      ["Meta", "2026-06-15", "C", "A", "10", "", "", "", ""],
      ["Meta", "2026-06-16", "C", "A", "10", "", "", "0", "0"],
      ["Meta", "2026-06-17", "C", "A", "10", "", "", "--", "n/a"],
    ]);
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => [x.leads, x.platform_bookings])).toEqual([[null, null], [0, 0], [null, null]]);
  });
  it("sums duplicate (date, platform, campaign, ad) rows across every numeric field", () => {
    const r = tpl([
      ["Meta", "2026-06-15", "C", "Ad One", "10", "100", "5", "3", "1"],
      ["Meta", "2026-06-15", "C", "Ad One", "5.5", "50", "2", "4", "0"],
    ]);
    if (!r.ok) throw new Error();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ spend_php: 15.5, impressions: 150, clicks: 7, leads: 7, platform_bookings: 1, ad_label: "Ad One" });
  });
  it("sums a known count with an unknown one as the known count, and two unknowns stay unknown", () => {
    const r = tpl([
      ["Meta", "2026-06-15", "C", "A", "1", "", "", "", "2"],
      ["Meta", "2026-06-15", "C", "A", "1", "", "", "4", ""],
      ["Meta", "2026-06-16", "C", "A", "1", "", "", "", ""],
      ["Meta", "2026-06-16", "C", "A", "1", "", "", "", ""],
    ]);
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => [x.leads, x.platform_bookings])).toEqual([[4, 2], [null, null]]);
  });
  it("maps a Meta export: Results = leads, and Cost per result / Result rate are never the count", () => {
    const headers = ["Reporting starts", "Reporting ends", "Campaign name", "Ad name", "Amount spent (PHP)", "Results", "Cost per result", "Result rate", "Purchases"];
    const r = parseAdSpendCsv(
      [{ "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "C", "Ad name": "A", "Amount spent (PHP)": "100", Results: "12", "Cost per result": "8.33", "Result rate": "3%", Purchases: "4" }],
      headers,
    );
    if (!r.ok) throw new Error();
    expect(r.rows[0]).toMatchObject({ leads: 12, platform_bookings: 4 });
  });
  it("maps a Google export: Conversions = bookings (fractional rounds), Conv. rate ignored", () => {
    const headers = ["Day", "Campaign", "Cost", "Conversions", "Conv. rate", "Cost / conv."];
    const r = parseAdSpendCsv(
      [{ Day: "2026-09-01", Campaign: "Search", Cost: "250", Conversions: "2.6", "Conv. rate": "4.1%", "Cost / conv.": "96" }],
      headers,
    );
    if (!r.ok) throw new Error();
    expect(r.rows[0]).toMatchObject({ platform_bookings: 3 });
    expect("leads" in r.rows[0]!).toBe(false);
  });
  it("a campaign-total row carries no ad label; an ad-ID row keeps the ad's name as its label", () => {
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "C", Cost: "1" },
        { Day: "2026-09-02", Campaign: "C", "Ad ID": "77", "Ad name": "Reel  A", Cost: "1" },
      ],
      ["Day", "Campaign", "Ad ID", "Ad name", "Cost"],
    );
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => [x.ad_key, x.ad_label])).toEqual([["(campaign)", null], ["id:77", "Reel  A"]]);
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
  it("skips an exact Total / Total: … row whose date cell is a placeholder, without counting it as rejected", () => {
    const r = parseAdSpendCsv(
      [row("2026-09-01", "Brand"), row(" --", "Total"), row("—", "Total: Account"), row("n/a", "total:campaigns")],
      H,
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => x.campaign_key)).toEqual(["brand"]);
    const meta = parseAdSpendCsv(
      [
        { "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Brand", "Amount spent (PHP)": "5" },
        { "Reporting starts": "—", "Reporting ends": "—", "Campaign name": "Total", "Amount spent (PHP)": "5" },
      ],
      ["Reporting starts", "Reporting ends", "Campaign name", "Amount spent (PHP)"],
    );
    expect(meta).toMatchObject({ ok: true, rejected: [] });
  });
  it("still keeps a dated 'Total Health' and rejects an undated / placeholder-dated one", () => {
    const kept = parseAdSpendCsv([row("2026-09-01", "Total Health", "7")], H);
    expect(kept).toMatchObject({ ok: true, rejected: [] });
    if (!kept.ok) throw new Error();
    expect(kept.rows).toHaveLength(1);
    expect(parseAdSpendCsv([row("2026-09-01", "Brand"), row(" --", "Total Health")], H))
      .toMatchObject({ ok: true, rejected: [{ reason: "bad_date", count: 1 }] });
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

describe("absent column vs blank cell (a re-upload must not erase saved values)", () => {
  const MIN = ["Date", "Platform", "Campaign", "Spend"];
  const rec = { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", Spend: "10" };

  it("omits the KEY of every field the file has no column for", () => {
    const r = parseAdSpendCsv([rec], MIN);
    if (!r.ok) throw new Error();
    for (const k of ["impressions", "clicks", "leads", "platform_bookings", "ad_label"]) {
      expect(Object.prototype.hasOwnProperty.call(r.rows[0], k), k).toBe(false);
    }
    // ... and the JSON the RPC receives has no such key either.
    expect(Object.keys(JSON.parse(JSON.stringify(r.rows[0]))).sort()).toEqual(
      ["ad_key", "campaign_key", "campaign_label", "platform", "spend_date", "spend_php"],
    );
  });
  it("keeps the key, with null, when the column exists but the cell is blank", () => {
    const hdr = [...MIN, "Ad name", "Impressions", "Clicks", "Leads", "Bookings"];
    const r = parseAdSpendCsv([{ ...rec, "Ad name": "", Impressions: "", Clicks: "", Leads: "", Bookings: "" }], hdr);
    if (!r.ok) throw new Error();
    expect(r.rows[0]).toMatchObject({ impressions: null, clicks: null, leads: null, platform_bookings: null, ad_label: null });
    for (const k of ["impressions", "clicks", "leads", "platform_bookings", "ad_label"]) {
      expect(Object.prototype.hasOwnProperty.call(r.rows[0], k), k).toBe(true);
    }
  });
  it("keeps 0 as 0 and includes only the columns that exist", () => {
    const r = parseAdSpendCsv([{ ...rec, Leads: "0" }], [...MIN, "Leads"]);
    if (!r.ok) throw new Error();
    expect(r.rows[0]!.leads).toBe(0);
    expect("platform_bookings" in r.rows[0]!).toBe(false);
    expect("impressions" in r.rows[0]!).toBe(false);
  });
});

describe("fractional conversions round once per stored row", () => {
  const hdr = ["Date", "Platform", "Campaign", "Ad name", "Spend", "Conv."];
  const row = (v: string, ad = "A") => ({ Date: "2026-09-01", Platform: "Google", Campaign: "C", "Ad name": ad, Spend: "1", "Conv.": v });
  it("three 0.4 rows for the same ad-day store 1", () => {
    const r = parseAdSpendCsv([row("0.4"), row("0.4"), row("0.4")], hdr);
    if (!r.ok) throw new Error();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.platform_bookings).toBe(1);
  });
  it("a single 0.4 row stores 0, and 2.5 stores 3 (half-up)", () => {
    const one = parseAdSpendCsv([row("0.4")], hdr);
    if (!one.ok) throw new Error();
    expect(one.rows[0]!.platform_bookings).toBe(0);
    const half = parseAdSpendCsv([row("2.5")], hdr);
    if (!half.ok) throw new Error();
    expect(half.rows[0]!.platform_bookings).toBe(3);
  });
  it("different ads are rounded separately", () => {
    const r = parseAdSpendCsv([row("0.4", "A"), row("0.4", "B")], hdr);
    if (!r.ok) throw new Error();
    expect(r.rows.map((x) => x.platform_bookings)).toEqual([0, 0]);
  });
});
