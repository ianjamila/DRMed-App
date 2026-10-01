import { describe, expect, it } from "vitest";
import {
  aggregateSpend,
  DIGEST_ALERT_KEY,
  digestPeriods,
  parseDigestParams,
  periodEnd,
  renderPatientSourcesDigest,
  retryPeriodError,
  spendIn,
  type DigestData,
} from "./patient-sources-digest";
import { asOfLabel, channelLabel, type SummaryRow } from "./patient-sources";
import { formatPhp } from "./format";

describe("digestPeriods", () => {
  it("weekly on a Monday: the Mon–Sun week just ended, against the week before", () => {
    expect(digestPeriods("week", "2026-10-05")).toEqual({
      cur: { from: "2026-09-28", to: "2026-10-04" },
      prev: { from: "2026-09-21", to: "2026-09-27" },
      tooEarly: false,
    });
  });
  it("monthly on the 1st: the month just ended, against the month before", () => {
    expect(digestPeriods("month", "2026-10-01")).toEqual({
      cur: { from: "2026-09-01", to: "2026-09-30" },
      prev: { from: "2026-08-01", to: "2026-08-31" },
      tooEarly: false,
    });
  });
  it("is leap-February and year-boundary safe", () => {
    expect(digestPeriods("month", "2024-03-01").cur).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(digestPeriods("month", "2024-03-01").prev).toEqual({ from: "2024-01-01", to: "2024-01-31" });
    expect(digestPeriods("month", "2027-01-01").cur).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(digestPeriods("week", "2027-01-04").cur).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
  it("drops the comparison (null) when the period before starts before Patient Sources' first date", () => {
    const m = digestPeriods("month", "2024-01-01"); // current = Dec 2023, previous would be Nov 2023
    expect(m.cur).toEqual({ from: "2023-12-01", to: "2023-12-31" });
    expect(m.prev).toBeNull();
    expect(m.tooEarly).toBe(false);
    const w = digestPeriods("week", "2023-12-11"); // current = Mon 4 Dec, previous = Mon 27 Nov
    expect(w.cur).toEqual({ from: "2023-12-04", to: "2023-12-10" });
    expect(w.prev).toBeNull();
    expect(w.tooEarly).toBe(false);
  });
  it("is too_early when the CURRENT period starts before the first date", () => {
    expect(digestPeriods("month", "2023-12-15").tooEarly).toBe(true); // Nov 2023
    expect(digestPeriods("week", "2023-12-04")).toMatchObject({ cur: { from: "2023-11-27", to: "2023-12-03" }, prev: null, tooEarly: true });
  });
});

describe("periodEnd", () => {
  it("is Sunday for a week and the last day for a month", () => {
    expect(periodEnd("week", "2026-09-28")).toBe("2026-10-04");
    expect(periodEnd("month", "2024-02-01")).toBe("2024-02-29");
    expect(periodEnd("month", "2026-12-01")).toBe("2026-12-31");
  });
});

describe("retryPeriodError (?period_from=)", () => {
  it("accepts a finished Monday week / 1st-of-month period not older than 62 days", () => {
    expect(retryPeriodError("week", "2026-10-05", "2026-10-12")).toBeNull();
    expect(retryPeriodError("month", "2026-10-01", "2026-12-01")).toBeNull(); // 61 days old
    expect(retryPeriodError("month", "2026-10-01", "2026-12-02")).toBeNull(); // exactly 62
  });
  it("refuses a period that is more than 62 days old (measured from its start)", () => {
    expect(retryPeriodError("month", "2026-10-01", "2026-12-03")).toMatch(/62 days/); // 63 days old
    expect(retryPeriodError("month", "2026-10-01", "2026-12-04")).toMatch(/62 days/);
    expect(retryPeriodError("week", "2026-07-27", "2026-10-12")).toMatch(/62 days/);
  });
  it("refuses a period that has not finished", () => {
    expect(retryPeriodError("week", "2026-10-12", "2026-10-12")).toMatch(/not finished/);
    expect(retryPeriodError("week", "2026-10-12", "2026-10-18")).toMatch(/not finished/); // ends today
    expect(retryPeriodError("month", "2026-10-01", "2026-10-31")).toMatch(/not finished/);
  });
  it("refuses a start that is not a Monday (weekly) or the 1st (monthly)", () => {
    expect(retryPeriodError("week", "2026-10-07", "2026-10-20")).toMatch(/Monday/);
    expect(retryPeriodError("month", "2026-10-05", "2026-11-20")).toMatch(/1st/);
  });
  it("refuses something that is not a real date", () => {
    expect(retryPeriodError("month", "banana", "2026-11-20")).toMatch(/real date/);
    expect(retryPeriodError("month", "2026-02-31", "2026-11-20")).toMatch(/real date/);
  });
});

describe("aggregateSpend", () => {
  it("sums per date × platform in whole cents and sorts by date then platform", () => {
    const out = aggregateSpend([
      { spend_date: "2026-09-29", platform: "meta", spend_php: "7.5" },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.1 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 0.2 },
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
    ]);
    expect(out).toEqual([
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.3 },
      { spend_date: "2026-09-29", platform: "meta", spend_php: 7.5 },
    ]);
  });
  it("refuses a platform it does not know rather than dropping its spend", () => {
    expect(() => aggregateSpend([{ spend_date: "2026-09-28", platform: "tiktok", spend_php: 1 }])).toThrow(/platform/);
  });
});

describe("spendIn / keys", () => {
  it("keeps only spend inside the period", () => {
    const rows = [
      { spend_date: "2026-09-27", platform: "meta" as const, spend_php: 1 },
      { spend_date: "2026-09-28", platform: "meta" as const, spend_php: 2 },
      { spend_date: "2026-10-05", platform: "meta" as const, spend_php: 3 },
    ];
    expect(spendIn(rows, { from: "2026-09-28", to: "2026-10-04" })).toEqual([rows[1]]);
  });
  it("maps each period to its alert key", () => {
    expect(DIGEST_ALERT_KEY).toEqual({ week: "patient_sources_weekly", month: "patient_sources_monthly" });
  });
});
const SUMMARY: SummaryRow = {
  new_confirmed: 9,
  new_unconfirmed: 3,
  returning_first_recorded: 4,
  served_confirmed: 30,
  served_unconfirmed: 5,
  undated_registrations: 0,
  source_recorded: 40,
  source_total: 45,
  sheet_last_dates: { lab: "2026-10-03", consult: "2026-10-02", customers: "2026-10-01" },
  sync_paused: false,
  last_synced_at: "2026-10-04T10:00:00Z",
  sheet_rows_present: true,
  last_run_status: "succeeded",
};
const sr = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0) => ({ bucket_start, channel, confirmed, unconfirmed });

function week(over: Partial<DigestData> = {}): DigestData {
  return {
    kind: "week",
    cur: {
      period: { from: "2026-09-28", to: "2026-10-04" },
      summary: { ...SUMMARY },
      servedByDay: [sr("2026-09-29", "walk_in", 10), sr("2026-10-04", "walk_in", 2)],
      newByDay: [sr("2026-09-29", "walk_in", 5, 1), sr("2026-09-30", "online_facebook", 4, 2)],
      revenue: [
        { channel: "walk_in", confirmed_php: 12000, unconfirmed_php: 0 },
        { channel: "online_facebook", confirmed_php: 8000, unconfirmed_php: 0 },
      ],
      referrers: [
        { doctor_label: "Dr. A", new_confirmed: 3, new_unconfirmed: 1 },
        { doctor_label: "Dr. B", new_confirmed: 2, new_unconfirmed: 0 },
      ],
    },
    prev: {
      period: { from: "2026-09-21", to: "2026-09-27" },
      summary: { ...SUMMARY, new_confirmed: 8, new_unconfirmed: 0, returning_first_recorded: 2, served_confirmed: 25, served_unconfirmed: 4 },
      servedByDay: [sr("2026-09-22", "walk_in", 10)],
      newByDay: [sr("2026-09-22", "walk_in", 3), sr("2026-09-23", "online_google", 5)],
      revenue: [{ channel: "walk_in", confirmed_php: 9000, unconfirmed_php: 0 }],
      referrers: [],
    },
    spend: [],
    spendEverSaved: false,
    readAt: new Date("2026-10-04T23:05:00Z"),
    ...over,
  };
}
const render = (d: DigestData) => renderPatientSourcesDigest(d, { appUrl: "https://drmed.ph/" });

describe("renderPatientSourcesDigest — headline", () => {
  it("subject carries the period label, the new count and the change", () => {
    expect(render(week()).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (▲ 4)");
  });
  it("says = 0 for no change and ▼ for a fall", () => {
    const flat = week();
    flat.prev!.summary = { ...SUMMARY };
    expect(render(flat).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (= 0)");
    const down = week();
    down.prev!.summary = { ...SUMMARY, new_confirmed: 20, new_unconfirmed: 0 };
    expect(render(down).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (▼ 8)");
  });
  it("without a comparison the subject has no change and the headline says so", () => {
    const out = render(week({ prev: null }));
    expect(out.subject).toBe("Patient sources, Wk of 28 Sep: 12 new");
    expect(out.text).toContain("no comparison");
    expect(out.html).not.toContain(">Before<");
  });
  it("shows new / served / returning with their changes", () => {
    const { text } = render(week());
    expect(text).toContain("New patients: 12 (9 confirmed · 3 unconfirmed) · ▲ 4");
    expect(text).toContain("Served: 35 · ▲ 6");
    expect(text).toContain("Returning (first recorded): 4 · ▲ 2");
  });
  it("zero new patients keeps served, revenue and the rest, and says so plainly", () => {
    const d = week();
    d.cur.summary = { ...SUMMARY, new_confirmed: 0, new_unconfirmed: 0 };
    d.cur.newByDay = [];
    d.prev = null;
    const { text } = render(d);
    expect(text).toContain("No new patients recorded this week");
    expect(text).toContain("Served: 35");
    expect(text).toContain("Revenue by channel");
  });
  it("monthly wording and label", () => {
    const d = week({ kind: "month" });
    d.cur.period = { from: "2026-09-01", to: "2026-09-30" };
    d.prev!.period = { from: "2026-08-01", to: "2026-08-31" };
    const out = render(d);
    expect(out.subject).toBe("Patient sources, Sep 2026: 12 new (▲ 4)");
    expect(out.text).toContain("this month");
    expect(out.text).not.toContain("Sun (half day)");
  });
});

describe("renderPatientSourcesDigest — movers and Sunday", () => {
  it("names the biggest mover", () => {
    expect(render(week()).text).toContain(`Biggest mover: ${channelLabel("online_facebook")} ▲ 6 (6 now, 0 before).`);
  });
  it("says no channel moved by more than 2 when none did", () => {
    const d = week();
    d.prev!.newByDay = [sr("2026-09-22", "walk_in", 6), sr("2026-09-23", "online_facebook", 6)];
    expect(render(d).text).toContain("No channel moved by more than 2.");
  });
  it("reports Sunday activity as an observation when the week before had none", () => {
    expect(render(week()).text).toContain("Sunday activity was recorded this week (2 served); none was recorded on Sunday the week before.");
    const d = week();
    d.prev!.servedByDay = [sr("2026-09-27", "walk_in", 1)];
    expect(render(d).text).not.toContain("Sunday activity was recorded");
  });
  it("the weekly day rows label Sunday as a half day and never add daily served counts into a total", () => {
    const out = render(week());
    expect(out.html).toContain("Sun (half day)");
    expect(out.text).toContain("Served that day");
    expect(out.text).toContain("not added up");
  });
});

describe("renderPatientSourcesDigest — channels, revenue, referrers", () => {
  it("lists a channel that fell to zero, in table order, with its change", () => {
    const { text } = render(week());
    expect(text).toContain(`${channelLabel("online_google")} | 0 | 5 | -5`);
    expect(text).toContain(`${channelLabel("walk_in")} | 6 | 3 | +3`);
  });
  it("revenue: confirmed only unless something is unconfirmed; total against before", () => {
    const base = render(week());
    expect(base.html).not.toContain(">Unconfirmed<");
    expect(base.text).toContain(`Total ${formatPhp(20000)}, before ${formatPhp(9000)} (▲ ${formatPhp(11000)})`);
    const d = week();
    d.cur.revenue[0] = { channel: "walk_in", confirmed_php: 12000, unconfirmed_php: 500 };
    expect(render(d).html).toContain(">Unconfirmed<");
  });
  it("top 5 referrers, busiest first; a sentence when there are none", () => {
    const d = week();
    d.cur.referrers = Array.from({ length: 7 }, (_, i) => ({ doctor_label: `Dr. ${"ABCDEFG"[i]}`, new_confirmed: 7 - i, new_unconfirmed: 0 }));
    const { text } = render(d);
    expect(text).toContain("Dr. A | 7");
    expect(text).toContain("Dr. E | 3");
    expect(text).not.toContain("Dr. F");
    d.cur.referrers = [];
    expect(render(d).text).toContain("No referring doctor recorded this week.");
  });
  it("escapes dynamic strings in html and leaves text raw", () => {
    const d = week();
    d.cur.referrers = [{ doctor_label: "<b>Dr. X</b>", new_confirmed: 2, new_unconfirmed: 0 }];
    const out = render(d);
    expect(out.html).toContain("&lt;b&gt;Dr. X&lt;/b&gt;");
    expect(out.html).not.toContain("<b>Dr. X</b>");
    expect(out.text).toContain("<b>Dr. X</b> | 2");
  });
});

describe("renderPatientSourcesDigest — cost per new patient", () => {
  const noMoneyZero = (s: string) => expect(s).not.toMatch(/₱0(?![.,\d])/);
  it("with no spend in the period says so, never ₱0 — and points at Ad Performance when nothing was ever saved", () => {
    const out = render(week());
    expect(out.text).toContain("No ad spend saved for this week.");
    expect(out.text).toContain("Ad spend is saved from Ad Performance → Save them to clinic records.");
    noMoneyZero(out.html);
    noMoneyZero(out.text);
    const saved = render(week({ spendEverSaved: true }));
    expect(saved.text).toContain("No ad spend saved for this week.");
    expect(saved.text).not.toContain("Ad spend is saved from Ad Performance");
  });
  it("with spend shows spend, new on spend days and the cost per platform", () => {
    const d = week({
      spend: [
        { spend_date: "2026-09-29", platform: "meta", spend_php: 600 },
        { spend_date: "2026-09-30", platform: "meta", spend_php: 400 },
        { spend_date: "2026-09-22", platform: "meta", spend_php: 500 },
      ],
      spendEverSaved: true,
    });
    const { text } = render(d);
    expect(text).toContain(formatPhp(1000));
    expect(text).toContain(formatPhp(166.67)); // 1,000 over the 6 Facebook patients who joined on spend days
    expect(text).not.toContain("No ad spend saved");
  });
});

describe("renderPatientSourcesDigest — data health, footer", () => {
  it("says nothing when the sheet is included and current", () => {
    const { text } = render(week());
    expect(text).not.toContain("Sheet data is not included yet");
    expect(text).not.toContain("Latest service date in the sheet");
  });
  it("explains each state the page explains, with the sheet dates under it", () => {
    const none = week();
    none.cur.summary = { ...SUMMARY, sheet_rows_present: false };
    expect(render(none).text).toContain("Sheet data is not included yet");
    const partial = week();
    partial.cur.summary = { ...SUMMARY, last_run_status: "partial" };
    const p = render(partial).text;
    expect(p).toContain("did not finish every tab");
    expect(p).toContain("Latest service date in the sheet: Lab");
    const paused = week();
    paused.cur.summary = { ...SUMMARY, sync_paused: true };
    expect(render(paused).text).toContain("The sheet sync is paused");
  });
  it("ends with the stamp, the button and the fine print", () => {
    const out = render(week());
    expect(out.text).toContain(asOfLabel(new Date("2026-10-04T23:05:00Z")));
    expect(out.text).toContain("https://drmed.ph/staff/marketing/patients?from=2026-09-28&to=2026-10-04&grain=day&mode=new");
    expect(out.html).toContain("from=2026-09-28&amp;to=2026-10-04");
    expect(out.html).toContain("Open Patient Sources");
    expect(out.text).toContain("Confirmed counts are patient records.");
    expect(out.text).toContain("You get this as an admin; change it in Admin Tools › Email Alerts.");
  });
});
describe("parseDigestParams", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("no parameters = the latest completed period, no unknowns", () => {
    expect(parseDigestParams(q(""), "week", "2026-10-12")).toEqual({ ok: true, periodFrom: null, includeUnknown: false });
  });
  it("accepts a valid retry period and include_unknown=1 together", () => {
    expect(parseDigestParams(q("period_from=2026-10-05&include_unknown=1"), "week", "2026-10-12")).toEqual({
      ok: true, periodFrom: "2026-10-05", includeUnknown: true,
    });
  });
  it("only the literal 1 turns include_unknown on", () => {
    expect(parseDigestParams(q("period_from=2026-10-05&include_unknown=true"), "week", "2026-10-12")).toMatchObject({ includeUnknown: false });
  });
  it("refuses include_unknown without period_from (unknowns are an operator action on a named period)", () => {
    expect(parseDigestParams(q("include_unknown=1"), "week", "2026-10-12")).toEqual({
      ok: false, error: "include_unknown needs period_from.",
    });
  });
  it("refuses an invalid period_from with the reason", () => {
    expect(parseDigestParams(q("period_from=2026-10-07"), "week", "2026-10-12")).toMatchObject({ ok: false, error: expect.stringMatching(/Monday/) });
    expect(parseDigestParams(q("period_from=2026-10-12"), "week", "2026-10-12")).toMatchObject({ ok: false, error: expect.stringMatching(/not finished/) });
  });
});
