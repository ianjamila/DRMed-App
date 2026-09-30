import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAdSpendRows } from "./patient-sources.server";
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
