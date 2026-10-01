import { describe, expect, it } from "vitest";
import {
  NOT_RECORDED, bucketLabel, capRows, channelLabel, comparisonPeriod, channelTable, newPatientsTile, chartData, classifyReportError,
  costPerNewPatient, parsePatientSourcesReport, formatNewToday, parseGrain, parseMode, previousPeriod, seriesCsvRows, sheetBanner,
  asOfLabel, lastCompletedWeek, previousWeek, lastCompletedMonth, previousMonth, trendWeeks, trendCardData,
  type SeriesRow, type SummaryRow,
} from "./patient-sources";
import { manilaDateTime } from "@/lib/dates/manila";

const row = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0): SeriesRow =>
  ({ bucket_start, channel, confirmed, unconfirmed });

describe("parsers and labels", () => {
  it("defaults mode to new and grain to day", () => {
    expect(parseMode("served")).toBe("served");
    expect(parseMode("x")).toBe("new");
    expect(parseGrain("week")).toBe("week");
    expect(parseGrain("month")).toBe("month");
    expect(parseGrain("period")).toBe("day");
  });
  it("labels channels, including Not recorded and unknown ids", () => {
    expect(channelLabel("online_facebook")).toBe("Facebook");
    expect(channelLabel(NOT_RECORDED)).toBe("Not recorded");
    expect(channelLabel("mystery_channel")).toBe("Mystery channel");
  });
  it("labels buckets without Date", () => {
    expect(bucketLabel("day", "2026-09-01")).toBe("1 Sep");
    expect(bucketLabel("week", "2026-08-31")).toBe("Wk of 31 Aug");
    expect(bucketLabel("month", "2026-09-01")).toBe("Sep 2026");
  });
});

describe("previousPeriod", () => {
  it("is the same length, ending the day before", () => {
    expect(previousPeriod("2026-09-01", "2026-09-30")).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(previousPeriod("2026-09-28", "2026-09-28")).toEqual({ from: "2026-09-27", to: "2026-09-27" });
    expect(previousPeriod("2026-01-01", "2026-01-07")).toEqual({ from: "2025-12-25", to: "2025-12-31" });
  });
});

describe("newPatientsTile (Booking Sources)", () => {
  it("says 'Not available before Dec 2023' with no error and no link when the summary was skipped", () => {
    expect(newPatientsTile(null)).toEqual({ value: "Not available before Dec 2023", error: false, linked: false });
  });
  it("shows the counts, or the error state when the load failed", () => {
    const ok = newPatientsTile({ ok: true, data: { new_confirmed: 1200, new_unconfirmed: 3 } as never });
    expect(ok).toMatchObject({ error: false, linked: true });
    expect(ok.value).toMatch(/confirmed · 3 unconfirmed/);
    expect(newPatientsTile({ ok: false, kind: "error", message: "x" })).toEqual({ value: "—", error: true, linked: true });
  });
});

describe("channelTable without a previous period", () => {
  it("reports no comparison (null) instead of a change against zero", () => {
    const t = channelTable([{ bucket_start: "2024-01-01", channel: "walk_in", confirmed: 2, unconfirmed: 1 }], null);
    expect(t[0]).toMatchObject({ total: 3, previousTotal: null, change: null });
  });
});

describe("channelTable", () => {
  it("adds share and change, keeps channels that only existed before, sorts by total", () => {
    const t = channelTable(
      [row("2026-09-01", "walk_in", 5, 1), row("2026-09-01", "online_facebook", 2)],
      [row("2026-08-01", "walk_in", 3), row("2026-08-01", "online_google", 4)],
    );
    expect(t.map((r) => r.channel)).toEqual(["walk_in", "online_facebook", "online_google"]);
    expect(t[0]).toMatchObject({ confirmed: 5, unconfirmed: 1, total: 6, previousTotal: 3, change: 3 });
    expect(t[0].share).toBeCloseTo(6 / 8);
    expect(t[2]).toMatchObject({ total: 0, previousTotal: 4, change: -4, share: 0 });
  });
});

describe("chartData", () => {
  it("builds one datum per bucket with confirmed/unconfirmed keys per channel", () => {
    const { rows, channels } = chartData(
      [row("2026-09-01", "walk_in", 2, 1), row("2026-09-02", "online_google", 1)],
      "day",
    );
    expect(channels.map((c) => c.key)).toEqual(["walk_in", "online_google"]);
    expect(rows).toEqual([
      { bucket: "2026-09-01", label: "1 Sep", walk_in__c: 2, walk_in__u: 1, online_google__c: 0, online_google__u: 0 },
      { bucket: "2026-09-02", label: "2 Sep", walk_in__c: 0, walk_in__u: 0, online_google__c: 1, online_google__u: 0 },
    ]);
  });
});

describe("costPerNewPatient", () => {
  it("divides spend by new customers on days with spend only", () => {
    const out = costPerNewPatient(
      [
        { spend_date: "2026-09-01", platform: "meta", spend_php: 1000 },
        { spend_date: "2026-09-02", platform: "meta", spend_php: 0 },
        { spend_date: "2026-09-01", platform: "google", spend_php: 500 },
      ],
      [
        row("2026-09-01", "online_facebook", 3, 1),
        row("2026-09-02", "online_facebook", 9),
        row("2026-09-03", "online_google", 7),
      ],
    );
    expect(out.find((c) => c.platform === "meta")).toMatchObject({
      spendPhp: 1000, days: 1, newConfirmed: 3, newUnconfirmed: 1, costPerNewPhp: 250,
    });
    expect(out.find((c) => c.platform === "google")).toMatchObject({
      spendPhp: 500, days: 1, newConfirmed: 0, newUnconfirmed: 0, costPerNewPhp: null,
    });
  });
});

describe("formatNewToday", () => {
  it("shows the top four channels, the rest as N more, and unconfirmed", () => {
    const f = formatNewToday([
      row("2026-09-28", "walk_in", 5), row("2026-09-28", "online_facebook", 2, 1),
      row("2026-09-28", "online_google", 1), row("2026-09-28", "doctor_referral", 1),
      row("2026-09-28", "flyers", 1), row("2026-09-28", NOT_RECORDED, 0, 2),
    ]);
    expect(f.total).toBe(13);
    expect(f.unconfirmed).toBe(3);
    expect(f.hint).toBe("5 Walk-in · 3 Facebook · 2 Not recorded · 1 Doctor referral · 2 more (3 unconfirmed)");
  });
  it("says so when nobody is new yet", () => {
    expect(formatNewToday([])).toEqual({ total: 0, unconfirmed: 0, hint: "No new patients recorded yet today" });
  });
});

describe("sheetBanner", () => {
  it("covers never-loaded, partial, paused-with-data and current", () => {
    expect(sheetBanner({ sheet_rows_present: false, sync_paused: true, last_run_status: null })).toMatch(/app records only/);
    expect(sheetBanner({ sheet_rows_present: true, sync_paused: false, last_run_status: "partial" })).toMatch(/did not finish every tab/);
    expect(sheetBanner({ sheet_rows_present: true, sync_paused: true, last_run_status: "succeeded" })).toMatch(/paused — sheet data is included/);
    expect(sheetBanner({ sheet_rows_present: true, sync_paused: false, last_run_status: "succeeded" })).toBeNull();
  });
});

describe("classifyReportError", () => {
  it("maps the report SQLSTATEs", () => {
    expect(classifyReportError({ code: "0A000", message: "x" }).kind).toBe("converted");
    expect(classifyReportError({ code: "42501", message: "x" }).kind).toBe("forbidden");
    expect(classifyReportError({ code: "22023", message: "x" }).kind).toBe("invalid");
    expect(classifyReportError(new Error("boom")).kind).toBe("error");
    expect(classifyReportError(null).kind).toBe("error");
  });
});

describe("seriesCsvRows", () => {
  it("puts the summary above the channel × bucket table", () => {
    const summary = {
      new_confirmed: 3, new_unconfirmed: 1, returning_first_recorded: 2, served_confirmed: 9,
      served_unconfirmed: 4, undated_registrations: 7, source_recorded: 3, source_total: 4,
      sheet_last_dates: {}, sync_paused: true, last_synced_at: null,
      sheet_rows_present: false, last_run_status: null,
    } satisfies SummaryRow;
    const rows = seriesCsvRows({ from: "2026-09-01", to: "2026-09-30", mode: "new", grain: "day" }, summary,
      [row("2026-09-01", "walk_in", 3, 1)]);
    expect(rows[0]).toEqual(["Patient Sources", "2026-09-01 to 2026-09-30", "New customers", "Day"]);
    expect(rows).toContainEqual(["New customers — confirmed", 3]);
    expect(rows).toContainEqual(["New customers — unconfirmed", 1]);
    expect(rows.at(-2)).toEqual(["Period start", "Channel", "Confirmed", "Unconfirmed"]);
    expect(rows.at(-1)).toEqual(["2026-09-01", "Walk-in", 3, 1]);
  });
});

describe("parsePatientSourcesReport", () => {
  const summary = {
    new_confirmed: 3, new_unconfirmed: 1, returning_first_recorded: 0, served_confirmed: 5, served_unconfirmed: 2,
    undated_registrations: 4, source_recorded: 2, source_total: 4, sheet_last_dates: { lab: "2026-06-12" },
    sync_paused: true, last_synced_at: null, sheet_rows_present: true, last_run_status: null,
  };
  const s = { bucket_start: "2026-06-01", channel: "walk_in", confirmed: 2, unconfirmed: 0 };
  const good = {
    summary, series: [s], current: [s], previous: null, new_by_day: [s],
    revenue: [{ channel: "walk_in", confirmed_php: 1500.5, unconfirmed_php: 0 }],
    overlaps: [{ patient_id: "p1", drm_id: "DRM-1", service_date: "2026-06-10", app_php: 500, sheet_php: 700 }],
    referrers: [{ doctor_label: "Dr. A", new_confirmed: 1, new_unconfirmed: 0 }],
  };

  it("returns every section typed as the single RPCs return them", () => {
    const r = parsePatientSourcesReport(good);
    expect(r).toEqual(good);
  });
  it("keeps previous as an array when a comparison period was asked for", () => {
    expect(parsePatientSourcesReport({ ...good, previous: [s] })?.previous).toEqual([s]);
  });
  it("coerces numeric strings to numbers (numeric can arrive as text)", () => {
    const r = parsePatientSourcesReport({ ...good, revenue: [{ channel: "x", confirmed_php: "12.50", unconfirmed_php: "0" }] });
    expect(r?.revenue[0]).toEqual({ channel: "x", confirmed_php: 12.5, unconfirmed_php: 0 });
  });
  it.each([
    ["not an object", 42],
    ["null", null],
    ["missing summary", { ...good, summary: undefined }],
    ["summary without counts", { ...good, summary: { ...summary, new_confirmed: "x" } }],
    ["series not an array", { ...good, series: {} }],
    ["missing referrers", { ...good, referrers: undefined }],
    ["previous neither null nor array", { ...good, previous: "no" }],
    ["a series row without a bucket", { ...good, series: [{ channel: "walk_in", confirmed: 1, unconfirmed: 0 }] }],
  ])("returns null for a malformed reply (%s)", (_label, raw) => {
    expect(parsePatientSourcesReport(raw)).toBeNull();
  });
});

describe("comparisonPeriod", () => {
  it("keeps a previous period that starts on or after the first date", () => {
    expect(comparisonPeriod({ from: "2023-12-01", to: "2023-12-31" }, "2023-12-01")).toEqual({ from: "2023-12-01", to: "2023-12-31" });
  });
  it("drops one that starts before it (the database would refuse it)", () => {
    expect(comparisonPeriod({ from: "2023-11-30", to: "2023-12-29" }, "2023-12-01")).toBeNull();
  });
});

describe("capRows", () => {
  it("keeps everything under the ceiling", () => {
    expect(capRows([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], truncated: false });
  });
  it("cuts at the ceiling and says so", () => {
    expect(capRows([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], truncated: true });
  });
});

describe("asOfLabel", () => {
  it("uses the house date-time format", () => {
    // 2026-10-01 01:14 UTC = 9:14 AM Manila
    expect(asOfLabel(new Date("2026-10-01T01:14:00Z"))).toBe(`Numbers as of ${manilaDateTime(new Date("2026-10-01T01:14:00Z"))}`);
    expect(asOfLabel(new Date("2026-10-01T01:14:00Z"))).toMatch(/^Numbers as of .*9:14 AM$/);
  });
});

describe("periods", () => {
  it("lastCompletedWeek is the Mon–Sun before the week containing today", () => {
    expect(lastCompletedWeek("2026-10-05")).toEqual({ from: "2026-09-28", to: "2026-10-04" }); // Monday
    expect(lastCompletedWeek("2026-10-04")).toEqual({ from: "2026-09-21", to: "2026-09-27" }); // Sunday
    expect(lastCompletedWeek("2026-10-01")).toEqual({ from: "2026-09-21", to: "2026-09-27" }); // Thursday
    expect(lastCompletedWeek("2027-01-01")).toEqual({ from: "2026-12-21", to: "2026-12-27" }); // year boundary
  });
  it("previousWeek is the Mon–Sun before a week", () => {
    expect(previousWeek({ from: "2026-09-28", to: "2026-10-04" })).toEqual({ from: "2026-09-21", to: "2026-09-27" });
  });
  it("lastCompletedMonth / previousMonth are calendar months (leap-safe)", () => {
    expect(lastCompletedMonth("2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(lastCompletedMonth("2024-03-15")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(lastCompletedMonth("2027-01-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(previousMonth({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });
  it("trendWeeks returns n completed weeks, oldest first, ending last Sunday", () => {
    const w = trendWeeks("2026-10-01", 8);
    expect(w).toHaveLength(8);
    expect(w[7]).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(w[0]).toEqual({ from: "2026-08-03", to: "2026-08-09" });
  });
});

describe("trendCardData", () => {
  const weeks = trendWeeks("2026-10-01", 8); // W8 = 21–27 Sep, this week starts 28 Sep
  const d = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0) => ({ bucket_start, channel, confirmed, unconfirmed });

  it("buckets days into the 8 weeks, keeps empty weeks, and computes the headline", () => {
    const t = trendCardData([d("2026-09-21", "walk_in", 3), d("2026-09-27", "walk_in", 1, 1), d("2026-09-15", "walk_in", 2),
      d("2026-09-29", "walk_in", 4)], [], weeks);
    expect(t.chart.rows).toHaveLength(8);
    expect(t.chart.rows[7]).toMatchObject({ bucket: "2026-09-21", walk_in__c: 4, walk_in__u: 1 });
    expect(t.chart.rows[6]).toMatchObject({ bucket: "2026-09-14", walk_in__c: 2 });
    expect(t.chart.rows[0]).toMatchObject({ bucket: "2026-08-03", walk_in__c: 0, walk_in__u: 0 });
    expect(t.lastWeek).toBe(5);
    expect(t.weekBefore).toBe(2);
    expect(t.pct).toBe(150);
    expect(t.thisWeekSoFar).toBe(4);
    expect(t.hasSpend).toBe(false);
  });

  it("folds channels beyond the top 5 into Other, drawn last", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((c, i) => d("2026-09-22", c, 10 - i));
    const t = trendCardData(rows, [], weeks);
    expect(t.chart.channels.map((c) => c.key)).toEqual(["a", "b", "c", "d", "e", "__other"]);
    expect(t.chart.channels.at(-1)).toMatchObject({ label: "Other channels", color: "#94a3b8" });
    expect(t.chart.rows[7]).toMatchObject({ __other__c: 5 + 4 }); // f=5, g=4
  });

  it("pct is null when the week before had nobody", () => {
    const t = trendCardData([d("2026-09-22", "walk_in", 2)], [], weeks);
    expect(t.weekBefore).toBe(0);
    expect(t.pct).toBeNull();
  });

  it("adds a combined cost per new patient only for weeks with spend", () => {
    const spend = [
      { spend_date: "2026-09-22", platform: "meta" as const, spend_php: 300 },
      { spend_date: "2026-09-23", platform: "google" as const, spend_php: 100 },
    ];
    const t = trendCardData([d("2026-09-22", "online_facebook", 2), d("2026-09-23", "online_google", 1, 1), d("2026-09-15", "online_facebook", 5)], spend, weeks);
    expect(t.hasSpend).toBe(true);
    expect(t.chart.rows[7].__cost).toBe(100); // (300+100) / (2+2)
    expect(t.chart.rows[6]).not.toHaveProperty("__cost"); // no spend that week → a gap, not zero
  });

  it("describes itself for screen readers", () => {
    const t = trendCardData([d("2026-09-22", "walk_in", 2), d("2026-09-15", "walk_in", 1)], [], weeks);
    expect(t.ariaLabel).toBe("New patients per week for 8 weeks. Last week 2, up 100% on the week before.");
  });
});
