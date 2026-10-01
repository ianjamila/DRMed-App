import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAdSpendRows, loadPatientSourcesReport, loadPatientSourcesTrend } from "./patient-sources.server";
import type { AdSpendDbRow } from "./patient-sources";

const row = (i: number): AdSpendDbRow => ({
  spend_date: "2026-09-01", platform: "meta", campaign_key: `c${String(i).padStart(6, "0")}`, campaign_label: "C", ad_key: "a", ad_label: null,
  spend_php: 1, impressions: null, clicks: null, leads: null, platform_bookings: null,
});

/** A supabase double for `.rpc(name,args).order(..)...range(a,b)` over `total` rows; records what was asked. */
function fake(total: number, fail?: { code: string }) {
  const calls = { rpc: [] as [string, unknown][], orders: [] as string[], ranges: [] as [number, number][] };
  const supabase = {
    rpc(name: string, args: unknown) {
      calls.rpc.push([name, args]);
      const b = {
        order(col: string) { calls.orders.push(col); return b; },
        range(a: number, z: number) {
          calls.ranges.push([a, z]);
          if (fail) return Promise.resolve({ data: null, error: fail });
          return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(z + 1, total) - a) }, (_, i) => row(a + i)), error: null });
        },
      };
      return b;
    },
  };
  return { supabase: supabase as never, calls };
}

describe("loadAdSpendRows", () => {
  it("pages past PostgREST's 1,000-row cap and returns every row", async () => {
    const { supabase, calls } = fake(2500);
    const res = await loadAdSpendRows(supabase, "2026-01-01", "2026-09-30");
    expect(res).toMatchObject({ ok: true, data: { truncated: false } });
    if (!res.ok) throw new Error();
    expect(res.data.rows).toHaveLength(2500);
    expect(new Set(res.data.rows.map((r) => r.campaign_key)).size).toBe(2500);
    expect(calls.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(calls.rpc[0]).toEqual(["ad_spend_rows", { p_from: "2026-01-01", p_to: "2026-09-30" }]);
  });
  it("orders by the function's whole unique key so paging cannot drop or repeat a row", async () => {
    const { supabase, calls } = fake(10);
    await loadAdSpendRows(supabase, "2026-01-01", "2026-09-30");
    expect(calls.orders).toEqual(["spend_date", "platform", "campaign_key", "ad_key"]);
  });
  it("stops on a page that is exactly full only when the next one is empty", async () => {
    const { supabase, calls } = fake(1000);
    const res = await loadAdSpendRows(supabase, "a", "b");
    expect(res.ok && res.data.rows.length).toBe(1000);
    expect(calls.ranges).toEqual([[0, 999], [1000, 1999]]);
  });
  it("surfaces truncation at the row ceiling instead of hiding it", async () => {
    const { supabase } = fake(25_000);
    const res = await loadAdSpendRows(supabase, "a", "b");
    expect(res).toMatchObject({ ok: true, data: { truncated: true } });
    if (res.ok) expect(res.data.rows).toHaveLength(20_000);
  });
  it("keeps the SQLSTATE: forbidden and invalid are told apart from a plain error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadAdSpendRows(fake(1, { code: "42501" }).supabase, "a", "b")).toMatchObject({ ok: false, kind: "forbidden" });
    expect(await loadAdSpendRows(fake(1, { code: "22023" }).supabase, "a", "b")).toMatchObject({ ok: false, kind: "invalid" });
    expect(await loadAdSpendRows(fake(1, { code: "XX000" }).supabase, "a", "b")).toMatchObject({ ok: false, kind: "error" });
  });
});

describe("loadPatientSourcesReport", () => {
  const s = { bucket_start: "2026-06-01", channel: "walk_in", confirmed: 1, unconfirmed: 0 };
  const reply = {
    summary: {
      new_confirmed: 1, new_unconfirmed: 0, returning_first_recorded: 0, served_confirmed: 1, served_unconfirmed: 0,
      undated_registrations: 0, source_recorded: 1, source_total: 1, sheet_last_dates: {}, sync_paused: true,
      last_synced_at: null, sheet_rows_present: false, last_run_status: null,
    },
    series: [s], current: [s], previous: null, new_by_day: [s], revenue: [], overlaps: [], referrers: [],
  };
  function one(data: unknown, error: { code: string } | null = null) {
    const calls: [string, unknown][] = [];
    const supabase = { rpc(name: string, args: unknown) { calls.push([name, args]); return Promise.resolve({ data, error }); } };
    return { supabase: supabase as never, calls };
  }

  it("makes exactly one call with the period, grain, mode and no comparison", async () => {
    const { supabase, calls } = one(reply);
    const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "week", mode: "served", prev: null });
    expect(calls).toEqual([["patient_sources_report", {
      p_from: "2026-06-01", p_to: "2026-06-30", p_grain: "week", p_mode: "served", p_prev_from: null, p_prev_to: null,
    }]]);
    expect(res).toMatchObject({ ok: true, data: { series: [s], previous: null } });
  });
  it("passes the comparison period when given", async () => {
    const { supabase, calls } = one({ ...reply, previous: [s] });
    await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: { from: "2026-05-02", to: "2026-05-31" } });
    expect(calls[0][1]).toMatchObject({ p_prev_from: "2026-05-02", p_prev_to: "2026-05-31" });
  });
  it.each([["42501", "forbidden"], ["22023", "invalid"], ["0A000", "converted"], ["XX000", "error"]] as const)(
    "classifies SQLSTATE %s as %s", async (code, kind) => {
      const { supabase } = one(null, { code });
      const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: null });
      expect(res).toMatchObject({ ok: false, kind });
    });
  it("treats a malformed reply as an error, never a crash", async () => {
    const { supabase } = one({ summary: {} });
    const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: null });
    expect(res).toMatchObject({ ok: false, kind: "error" });
  });
});

describe("loadPatientSourcesTrend", () => {
  const summary = {
    new_confirmed: 0, new_unconfirmed: 0, returning_first_recorded: 0, served_confirmed: 0, served_unconfirmed: 0,
    undated_registrations: 0, source_recorded: 0, source_total: 0, sheet_last_dates: {}, sync_paused: false,
    last_synced_at: null, sheet_rows_present: true, last_run_status: null,
  };
  const nbd = [{ bucket_start: "2026-09-22", channel: "walk_in", confirmed: 2, unconfirmed: 0 }];
  function both(spendError: { code: string } | null = null) {
    const calls: [string, unknown][] = [];
    const supabase = {
      rpc(name: string, args: unknown) {
        calls.push([name, args]);
        if (name === "patient_sources_report") {
          return Promise.resolve({ data: { summary, series: [], current: [], previous: null, new_by_day: nbd, revenue: [], overlaps: [], referrers: [] }, error: null });
        }
        const b = { order() { return b; }, range() { return Promise.resolve({ data: spendError ? null : [], error: spendError }); } };
        return b;
      },
    };
    return { supabase: supabase as never, calls };
  }

  it("reads 8 completed weeks through today in ONE report call, plus ad spend over the 8 weeks", async () => {
    const { supabase, calls } = both();
    const res = await loadPatientSourcesTrend(supabase, "2026-10-01");
    expect(calls[0]).toEqual(["patient_sources_report", {
      p_from: "2026-08-03", p_to: "2026-10-01", p_grain: "week", p_mode: "new", p_prev_from: null, p_prev_to: null,
    }]);
    expect(calls[1]).toEqual(["ad_spend_daily_totals", { p_from: "2026-08-03", p_to: "2026-09-27" }]);
    expect(res.ok && res.data.newByDay).toEqual(nbd);
    expect(res.ok && res.data.spend).toEqual({ ok: true, rows: [] });
    expect(res.ok && res.data.weeks).toHaveLength(8);
    expect(res.ok && typeof res.data.readAt).toBe("string");
  });

  it("keeps the bars when only ad spend fails", async () => {
    const { supabase } = both({ code: "XX000" });
    const res = await loadPatientSourcesTrend(supabase, "2026-10-01");
    expect(res.ok && res.data.spend.ok).toBe(false);
  });
});
