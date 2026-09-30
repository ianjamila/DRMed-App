import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { countPatientsCreated, runFirstNightCheck, type CheckDeps } from "./first-night-check.server";
import { FORBIDDEN_CHECK_MESSAGE, groupLoadErrors } from "./first-night-check";
import type { ReportResult, SeriesRow, SummaryRow } from "./patient-sources";

const summaryRow = (c: number, u = 0, over: Partial<SummaryRow> = {}): SummaryRow => ({
  new_confirmed: c, new_unconfirmed: u, returning_first_recorded: 0, served_confirmed: 0, served_unconfirmed: 0,
  undated_registrations: 2, source_recorded: 0, source_total: 0, sheet_last_dates: {}, sync_paused: true,
  last_synced_at: "2026-09-30T01:00:00Z", sheet_rows_present: true, last_run_status: "succeeded", ...over,
});
const ok = <T,>(data: T): ReportResult<T> => ({ ok: true, data });
const bad = { ok: false as const, kind: "error" as const, message: "Couldn't load" };
const series = (rows: SeriesRow[], truncated = false) => ({ ok: true as const, data: { rows, truncated } });

// A world where day 2026-09-29 has 4 confirmed + 1 unconfirmed and 09-30 has 2 confirmed.
const perDay: Record<string, { c: number; u: number; ch: string }> = {
  "2026-09-29": { c: 4, u: 1, ch: "walk_in" },
  "2026-09-30": { c: 2, u: 0, ch: "walk_in" },
};
function deps(over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    loadSummary: (async (_c: unknown, from: string, to: string) => {
      let c = 0, u = 0;
      for (const [d, v] of Object.entries(perDay)) if (d >= from && d <= to) { c += v.c; u += v.u; }
      return ok(summaryRow(c, u));
    }) as CheckDeps["loadSummary"],
    loadSeries: (async () =>
      series(Object.entries(perDay).map(([d, v]) => ({ bucket_start: d, channel: v.ch, confirmed: v.c, unconfirmed: v.u })))) as CheckDeps["loadSeries"],
    loadToday: (async (_c: unknown, d: string) => {
      const v = perDay[d];
      return ok(v ? [{ bucket_start: d, channel: v.ch, confirmed: v.c, unconfirmed: v.u }] : []);
    }) as CheckDeps["loadToday"],
    countCreated: async (_c, d) => (d === "2026-09-30" ? { app: 2, imported: 560 } : { app: 5, imported: 0 }),
    ...over,
  };
}
const client = {} as never;
const params = { from: "2026-09-29", to: "2026-09-30", threshold: 40 };

describe("runFirstNightCheck", () => {
  it("passes when every screen agrees, and shows imported records without judging them", async () => {
    const { report, durationMs } = await runFirstNightCheck(client, params, deps());
    expect(report.verdict).toBe("pass");
    expect(report.days.map((d) => d.created)).toEqual([{ app: 5, imported: 0 }, { app: 2, imported: 560 }]);
    expect(report.days[1]).toMatchObject({ summary: { confirmed: 2, unconfirmed: 0 }, tile: { confirmed: 2, unconfirmed: 0 }, spike: false });
    expect(report.totals.find((t) => t.key === "booking_sources")?.text).toBe("6 confirmed · 1 unconfirmed");
    expect(report.sync).toEqual({ paused: true, lastSyncedAt: "2026-09-30T01:00:00Z", lastRunStatus: "succeeded", undatedRegistrations: 2 });
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fills a day the chart omits with zero (the series only returns non-empty cells)", async () => {
    const { report } = await runFirstNightCheck(client, { ...params, from: "2026-09-28" }, deps());
    expect(report.days[0]).toMatchObject({ date: "2026-09-28", chart: { confirmed: 0, unconfirmed: 0 }, summary: { confirmed: 0, unconfirmed: 0 } });
    expect(report.verdict).toBe("pass");
  });

  it("reports a real disagreement between screens", async () => {
    const { report } = await runFirstNightCheck(client, params, deps({
      loadToday: (async (_c: unknown, d: string) =>
        ok(d === "2026-09-29" ? [{ bucket_start: d, channel: "walk_in", confirmed: 4, unconfirmed: 0 }] : [{ bucket_start: d, channel: "walk_in", confirmed: 2, unconfirmed: 0 }])) as CheckDeps["loadToday"],
    }));
    expect(report.verdict).toBe("mismatch");
    expect(report.mismatches.map((m) => m.kind).sort()).toEqual(["dashboard_total", "day_dashboard"]);
  });

  it("flags a spike from the dashboard tile's count", async () => {
    const { report } = await runFirstNightCheck(client, params, deps({
      loadToday: (async (_c: unknown, d: string) =>
        ok([{ bucket_start: d, channel: "walk_in", confirmed: 100, unconfirmed: 0 }])) as CheckDeps["loadToday"],
    }));
    expect(report.spikes.length).toBe(2);
    // The dashboard tile (100) also disagrees with Patient Sources, so mismatch outranks the spike.
    expect(report.verdict).toBe("mismatch");
    expect(report.mismatches.map((m) => m.kind)).toContain("day_dashboard");
  });

  it("a day every screen agrees on, above the threshold, is a spike (and only a spike)", async () => {
    perDay["2026-09-30"] = { c: 560, u: 0, ch: "walk_in" };
    try {
      const { report } = await runFirstNightCheck(client, params, deps());
      expect(report.verdict).toBe("spike");
      expect(report.mismatches).toEqual([]);
      expect(report.spikes).toEqual([{ date: "2026-09-30", count: 560 }]);
    } finally {
      perDay["2026-09-30"] = { c: 2, u: 0, ch: "walk_in" };
    }
  });

  it("a View-as refusal on every day collapses to a plain admin-only message, not one line per day", async () => {
    const forbidden = { ok: false as const, kind: "forbidden" as const, message: "Patient Sources is for admins only. If you are using View as, switch back to Admin." };
    const { report } = await runFirstNightCheck(client, params, deps({
      loadSummary: (async () => forbidden) as CheckDeps["loadSummary"],
      loadToday: (async () => forbidden) as CheckDeps["loadToday"],
    }));
    expect(report.verdict).toBe("error");
    expect(report.errors.every((e) => e.message === FORBIDDEN_CHECK_MESSAGE)).toBe(true);
    const groups = groupLoadErrors(report.errors);
    expect(groups.length).toBeLessThan(report.errors.length);
    expect(groups.find((g) => g.what === "the dashboard tile")).toMatchObject({ count: 2 });
    expect(FORBIDDEN_CHECK_MESSAGE).toMatch(/admin who is not viewing as another role/);
  });

  it("names each load that failed and never treats it as zero", async () => {
    const { report } = await runFirstNightCheck(client, params, deps({
      loadSeries: (async () => bad) as CheckDeps["loadSeries"],
      loadToday: (async (_c: unknown, d: string) => (d === "2026-09-30" ? bad : ok([]))) as CheckDeps["loadToday"],
      countCreated: async () => { throw new Error("db down"); },
    }));
    expect(report.verdict).toBe("error");
    expect(report.errors.map((e) => e.what)).toEqual(expect.arrayContaining([
      "the Patient Sources day-by-day chart", "the dashboard tile", "the patient records count",
    ]));
    expect(report.days[0].chart).toBeNull();
    expect(report.days[1].tile).toBeNull();
    expect(report.days[0].created).toBeNull();
  });

  it("treats a truncated chart as an error, not a smaller number", async () => {
    const { report } = await runFirstNightCheck(client, params, deps({
      loadSeries: (async () => series([], true)) as CheckDeps["loadSeries"],
    }));
    expect(report.verdict).toBe("error");
    expect(report.errors[0].message).toMatch(/cut off/);
  });

  it("does not compare anything when the Patient Sources card itself fails", async () => {
    const { report } = await runFirstNightCheck(client, params, deps({
      loadSummary: (async (_c: unknown, from: string, to: string) =>
        from === params.from && to === params.to ? bad : ok(summaryRow(0))) as CheckDeps["loadSummary"],
    }));
    expect(report.verdict).toBe("error");
    expect(report.errors.some((e) => e.what === "Patient Sources")).toBe(true);
    expect(report.mismatches.filter((m) => m.date === null)).toEqual([]);
  });

  it("never runs more than 4 per-day loads at once", async () => {
    let inFlight = 0, peak = 0;
    await runFirstNightCheck(client, { from: "2026-09-01", to: "2026-09-20", threshold: 40 }, deps({
      loadToday: (async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
        return ok([]);
      }) as CheckDeps["loadToday"],
    }));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("countPatientsCreated", () => {
  it("counts the Manila day [00:00+08, next 00:00+08), split by legacy_import_run_id", async () => {
    const calls: string[][] = [];
    const builder = (log: string[]) => {
      const b: Record<string, unknown> = {};
      const chain = (name: string) => (...a: unknown[]) => { log.push(`${name}(${a.join(",")})`); return b; };
      for (const m of ["is", "gte", "lt", "not"]) b[m] = chain(m);
      b.select = chain("select");
      b.then = (res: (v: unknown) => void) => res({ count: log.some((l) => l.startsWith("not(")) ? 560 : 3, error: null });
      return b;
    };
    const fake = { from: () => { const log: string[] = []; calls.push(log); return builder(log); } };
    const out = await countPatientsCreated(fake as never, "2026-09-30");
    expect(out).toEqual({ app: 3, imported: 560 });
    expect(calls).toHaveLength(2);
    for (const log of calls) {
      expect(log).toContain("gte(created_at,2026-09-30T00:00:00+08:00)");
      expect(log).toContain("lt(created_at,2026-10-01T00:00:00+08:00)");
      expect(log.some((l) => l.includes("deleted_at"))).toBe(false); // history read: never filtered
    }
    expect(calls.some((l) => l.includes("is(legacy_import_run_id,)"))).toBe(true);
    expect(calls.some((l) => l.includes("not(legacy_import_run_id,is,)"))).toBe(true);
  });
});
