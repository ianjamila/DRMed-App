import { describe, expect, it } from "vitest";
import {
  cliCommand, enumerateDays, evaluateCheck, exitCodeFor, formatReportText, parseCheckParams,
  type CheckInput, type Counts, type DayInput,
} from "./first-night-check";

const c = (confirmed: number, unconfirmed = 0): Counts => ({ confirmed, unconfirmed });
const TODAY = "2026-09-30";
const opts = { maxDays: 31, today: TODAY };

describe("parseCheckParams", () => {
  it("defaults to the last 7 days ending today, threshold 40", () => {
    expect(parseCheckParams({}, opts)).toEqual({ ok: true, params: { from: "2026-09-24", to: TODAY, threshold: 40 } });
  });
  it("defaults 'from' to 6 days before a given 'to'", () => {
    expect(parseCheckParams({ to: "2026-09-10" }, opts)).toEqual({ ok: true, params: { from: "2026-09-04", to: "2026-09-10", threshold: 40 } });
  });
  it("accepts an explicit range and threshold", () => {
    expect(parseCheckParams({ from: "2026-09-01", to: "2026-09-30", threshold: "100" }, opts)).toEqual({
      ok: true, params: { from: "2026-09-01", to: "2026-09-30", threshold: 100 },
    });
  });
  it("refuses junk, impossible dates, backwards and future ranges in plain English", () => {
    const bad = (raw: Parameters<typeof parseCheckParams>[0]) => {
      const r = parseCheckParams(raw, opts);
      return r.ok ? [] : r.errors;
    };
    expect(bad({ from: "abc", to: TODAY })[0]).toMatch(/first day isn't a real date/);
    expect(bad({ from: "2026-02-30", to: TODAY })[0]).toMatch(/first day isn't a real date/);
    expect(bad({ from: "2026-09-10", to: "2026-09-05" })).toEqual(["The first day must be on or before the last day."]);
    expect(bad({ from: "2026-09-10", to: "2026-10-01" })[0]).toMatch(/can't be in the future/);
    expect(bad({ from: "2023-11-30", to: "2023-12-05" })[0]).toMatch(/1 December 2023/);
  });
  it("caps the range at maxDays (inclusive)", () => {
    expect(parseCheckParams({ from: "2026-08-31", to: "2026-09-30" }, opts).ok).toBe(true); // 31 days
    const r = parseCheckParams({ from: "2026-08-30", to: "2026-09-30" }, opts); // 32 days
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/at most 31 days/);
    expect(parseCheckParams({ from: "2026-08-30", to: "2026-09-30" }, { ...opts, maxDays: 400 }).ok).toBe(true);
  });
  it("validates the threshold (1 to 100,000, whole number)", () => {
    const t = (v: string) => parseCheckParams({ threshold: v }, opts).ok;
    expect(t("1")).toBe(true);
    expect(t("100000")).toBe(true);
    expect(t("0")).toBe(false);
    expect(t("100001")).toBe(false);
    expect(t("4.5")).toBe(false);
    expect(t("-3")).toBe(false);
    expect(t("lots")).toBe(false);
  });
  it("reports every problem at once", () => {
    const r = parseCheckParams({ from: "x", to: "y", threshold: "0" }, opts);
    expect(!r.ok && r.errors).toHaveLength(3);
  });
});

describe("enumerateDays", () => {
  it("lists each day inclusive, across a month end", () => {
    expect(enumerateDays("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(enumerateDays("2026-09-30", "2026-09-30")).toEqual(["2026-09-30"]);
  });
});

function day(date: string, n: Counts, over: Partial<DayInput> = {}): DayInput {
  return { date, summary: n, chart: n, tile: n, created: { app: n.confirmed, imported: 0 }, ...over };
}
function input(days: DayInput[], over: Partial<CheckInput> = {}): CheckInput {
  const sum = days.reduce((s, d) => ({ confirmed: s.confirmed + (d.summary?.confirmed ?? 0), unconfirmed: s.unconfirmed + (d.summary?.unconfirmed ?? 0) }), c(0, 0));
  return {
    params: { from: days[0].date, to: days[days.length - 1].date, threshold: 40 },
    patientSourcesCard: sum,
    bookingCardText: `${sum.confirmed} confirmed · ${sum.unconfirmed} unconfirmed`,
    chartTotal: sum,
    days,
    loadErrors: [],
    sync: { paused: false, lastSyncedAt: null, lastRunStatus: "succeeded", undatedRegistrations: 0 },
    ...over,
  };
}

describe("evaluateCheck", () => {
  const calm = [day("2026-09-28", c(4, 1)), day("2026-09-29", c(6)), day("2026-09-30", c(0))];

  it("passes when every screen agrees and no day is high", () => {
    const r = evaluateCheck(input(calm));
    expect(r.verdict).toBe("pass");
    expect(r.headline).toBe("All screens agree");
    expect(r.mismatches).toEqual([]);
    expect(r.stats).toMatchObject({ threshold: 40, median: 5, max: 6, maxDate: "2026-09-29" });
    expect(r.totals.find((t) => t.key === "sum_of_days")?.agrees).toBe(true);
    expect(exitCodeFor(r.verdict)).toBe(0);
  });

  it("treats a day exactly at the threshold as NOT a spike, one above as a spike", () => {
    expect(evaluateCheck(input([day("2026-09-30", c(40))])).verdict).toBe("pass");
    const r = evaluateCheck(input([day("2026-09-29", c(3)), day("2026-09-30", c(41))]));
    expect(r.verdict).toBe("spike");
    expect(r.headline).toBe("A day jumped above 40 new patients");
    expect(r.spikes).toEqual([{ date: "2026-09-30", count: 41 }]);
    expect(r.days[1].spike).toBe(true);
    expect(exitCodeFor("spike")).toBe(2);
  });
  it("pluralises several spike days and counts confirmed + unconfirmed together", () => {
    const r = evaluateCheck(input([day("2026-09-29", c(30, 20)), day("2026-09-30", c(60))]));
    expect(r.headline).toBe("2 days jumped above 40 new patients");
  });
  it("judges a spike by the highest number any screen shows", () => {
    const r = evaluateCheck(input([day("2026-09-30", c(3), { tile: c(560) })]));
    expect(r.days[0].count).toBe(560);
    expect(r.days[0].spike).toBe(true);
  });

  it("flags the Booking Sources tile differing from the Patient Sources card", () => {
    const r = evaluateCheck(input(calm, { bookingCardText: "9 confirmed · 1 unconfirmed" }));
    expect(r.verdict).toBe("mismatch");
    expect(r.mismatches[0]).toMatchObject({ kind: "booking_card", surface: "Booking Sources", date: null, expected: "10 confirmed · 1 unconfirmed", actual: "9 confirmed · 1 unconfirmed" });
    expect(r.headline).toMatch(/^Screens disagree — Booking Sources shows 9 confirmed/);
    expect(exitCodeFor("mismatch")).toBe(1);
  });
  it("flags the chart total differing", () => {
    const r = evaluateCheck(input(calm, { chartTotal: c(10, 0) }));
    expect(r.mismatches.map((m) => m.kind)).toEqual(["chart_total"]);
  });
  it("flags the dashboard tiles summing differently, naming the day", () => {
    const days = [day("2026-09-28", c(4, 1)), day("2026-09-29", c(6), { tile: c(5) })];
    const r = evaluateCheck(input(days));
    expect(r.mismatches.map((m) => m.kind).sort()).toEqual(["dashboard_total", "day_dashboard"]);
    const d = r.mismatches.find((m) => m.kind === "day_dashboard")!;
    expect(d).toMatchObject({ date: "2026-09-29", expected: "6 confirmed · 0 unconfirmed", actual: "5 confirmed · 0 unconfirmed" });
    expect(d.message).toContain("Sep 29, 2026");
    expect(r.days[1].mismatch).toBe(true);
    expect(r.days[0].mismatch).toBe(false);
  });
  it("flags a chart bucket differing from that day's summary", () => {
    const days = [day("2026-09-29", c(6), { chart: c(6, 2) })];
    const r = evaluateCheck(input(days));
    expect(r.mismatches.map((m) => m.kind)).toContain("day_chart");
  });
  it("flags the sum of the days differing from the whole range", () => {
    const r = evaluateCheck(input(calm, { patientSourcesCard: c(10, 3), bookingCardText: "10 confirmed · 3 unconfirmed", chartTotal: c(10, 3) }));
    const m = r.mismatches.find((x) => x.kind === "sum_of_days")!;
    expect(m.message).toContain("exactly one day");
  });
  it("a mismatch outranks a spike, and spikes are still listed", () => {
    const r = evaluateCheck(input([day("2026-09-30", c(100))], { chartTotal: c(99) }));
    expect(r.verdict).toBe("mismatch");
    expect(r.spikes).toHaveLength(1);
  });

  it("an error outranks everything and names what failed; unknowns are never compared as zero", () => {
    const days = [day("2026-09-29", c(6), { tile: null }), day("2026-09-30", c(100))];
    const r = evaluateCheck(input(days, {
      loadErrors: [{ what: "the dashboard tile", date: "2026-09-29", message: "boom" }],
      chartTotal: c(1),
    }));
    expect(r.verdict).toBe("error");
    expect(r.headline).toBe("The check couldn't finish — the dashboard tile could not be loaded");
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(r.totals.find((t) => t.key === "dashboard")?.counts).toBeNull();
    expect(r.totals.find((t) => t.key === "dashboard")?.agrees).toBeNull();
    expect(exitCodeFor("error")).toBe(1);
  });
  it("when the reference itself failed, nothing is compared", () => {
    const r = evaluateCheck(input(calm, { patientSourcesCard: null, loadErrors: [{ what: "Patient Sources", message: "x" }] }));
    expect(r.verdict).toBe("error");
    expect(r.mismatches).toEqual([]);
  });

  it("copes with a range of empty days", () => {
    const r = evaluateCheck(input([day("2026-09-29", c(0)), day("2026-09-30", c(0))]));
    expect(r.verdict).toBe("pass");
    expect(r.stats).toMatchObject({ median: 0, max: 0 });
  });
  it("median of an even number of days is the midpoint", () => {
    const r = evaluateCheck(input([day("2026-09-27", c(2)), day("2026-09-28", c(4)), day("2026-09-29", c(6)), day("2026-09-30", c(8))]));
    expect(r.stats.median).toBe(5);
  });
});

describe("text output", () => {
  it("prints the verdict, the totals and one line per day, and the CLI command round-trips", () => {
    const r = evaluateCheck(input([day("2026-09-29", c(3)), day("2026-09-30", c(41), { created: { app: 1, imported: 560 } })]));
    const out = formatReportText(r);
    expect(out).toContain("A day jumped above 40 new patients");
    expect(out).toContain("2026-09-30");
    expect(out).toContain("1 / 560");
    expect(out).toContain("SPIKE");
    expect(cliCommand(r.params)).toBe("npm run first-night:check -- --from 2026-09-29 --to 2026-09-30 --threshold 40");
  });
});
