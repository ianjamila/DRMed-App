import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const loadReport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/marketing/patient-sources.server", () => ({ loadPatientSourcesReport: loadReport }));

import { shiftISODate } from "@/lib/dates/manila";
import type { PatientSourcesReport, SummaryRow } from "./patient-sources";
import { buildPatientSourcesDigestEmail, loadPatientSourcesDigest, readSpend } from "./patient-sources-digest.server";

const SUMMARY: SummaryRow = {
  new_confirmed: 9, new_unconfirmed: 3, returning_first_recorded: 4, served_confirmed: 30, served_unconfirmed: 5,
  undated_registrations: 0, source_recorded: 40, source_total: 45, sheet_last_dates: {}, sync_paused: false,
  last_synced_at: null, sheet_rows_present: true, last_run_status: "succeeded",
};
const report = (): PatientSourcesReport => ({
  summary: { ...SUMMARY }, series: [], current: [], previous: null, new_by_day: [], revenue: [], overlaps: [], referrers: [],
});

interface Row { spend_date: string; platform: "meta" | "google"; campaign_key: string; ad_key: string; spend_php: number; cents: number }
interface Rec { orders: string[]; ranges: Array<[number, number]>; bounds: Array<[string, string]>; counts: number }

/** Just enough of the service-role client: select/gte/lte/order/range/returns, and head-count selects. */
function fakeAdmin(table: () => Row[]) {
  const rec: Rec = { orders: [], ranges: [], bounds: [], counts: 0 };
  const from = (name: string) => {
    if (name !== "ad_spend_daily") throw new Error(`unexpected table ${name}`);
    return {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        let lo = "0000-00-00";
        let hi = "9999-99-99";
        const orders: string[] = [];
        let range: [number, number] | null = null;
        const run = () => {
          const rows = table().filter((r) => r.spend_date >= lo && r.spend_date <= hi);
          if (lo !== "0000-00-00") rec.bounds.push([lo, hi]);
          if (opts?.head) {
            rec.counts += 1;
            return { count: rows.length, data: null, error: null };
          }
          const sorted = [...rows].sort((a, b) => {
            for (const c of orders) {
              const x = String(a[c as keyof Row]);
              const y = String(b[c as keyof Row]);
              if (x !== y) return x < y ? -1 : 1;
            }
            return 0;
          });
          return { count: null, data: range ? sorted.slice(range[0], range[1] + 1) : sorted, error: null };
        };
        const b: Record<string, unknown> = {
          gte: (_c: string, v: string) => {
            lo = v;
            return b;
          },
          lte: (_c: string, v: string) => {
            hi = v;
            return b;
          },
          order: (c: string) => {
            orders.push(c);
            rec.orders.push(c);
            return b;
          },
          range: (a: number, z: number) => {
            range = [a, z];
            rec.ranges.push([a, z]);
            return b;
          },
          returns: () => b,
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
        };
        return b;
      },
    };
  };
  return { admin: { from } as never, rec };
}

/** 14 days × 2 platforms × 9 campaigns × 9 ads = 2,268 rows: repeated dates/platforms, distinct keys, > 2 pages. */
function bigSpend(): Row[] {
  const out: Row[] = [];
  let i = 0;
  for (let d = 0; d < 14; d++)
    for (const platform of ["meta", "google"] as const)
      for (let c = 0; c < 9; c++)
        for (let a = 0; a < 9; a++) {
          const cents = 1000 + (i % 7) * 37 + (i % 3);
          out.push({ spend_date: shiftISODate("2026-09-21", d), platform, campaign_key: `c${c}`, ad_key: `a${a}`, spend_php: cents / 100, cents });
          i++;
        }
  // a deterministic scramble, so a loader that forgot ORDER BY would page wrongly
  return out.map((r, k) => [(k * 7919) % out.length, r] as const).sort((x, y) => x[0] - y[0]).map(([, r]) => r);
}

beforeEach(() => {
  loadReport.mockReset();
});

describe("readSpend", () => {
  it("pages the table under a total order and totals exactly like the admin-only totals (per date × platform)", async () => {
    const rows = bigSpend();
    const { admin, rec } = fakeAdmin(() => rows);
    const out = await readSpend(admin, { from: "2026-09-21", to: "2026-10-04" });

    const ref = new Map<string, number>();
    for (const r of rows) ref.set(`${r.spend_date}|${r.platform}`, (ref.get(`${r.spend_date}|${r.platform}`) ?? 0) + r.cents);
    const expected = [...ref.entries()]
      .map(([k, cents]) => ({ spend_date: k.split("|")[0]!, platform: k.split("|")[1] as "meta" | "google", spend_php: cents / 100 }))
      .sort((a, b) => a.spend_date.localeCompare(b.spend_date) || a.platform.localeCompare(b.platform));
    expect(out).toEqual(expected);
    expect(out).toHaveLength(28);

    expect(rec.ranges.length).toBeGreaterThanOrEqual(3); // more than one 1,000-row page
    expect(rec.orders.length % 4).toBe(0);
    for (let i = 0; i < rec.orders.length; i += 4) {
      expect(rec.orders.slice(i, i + 4)).toEqual(["spend_date", "platform", "campaign_key", "ad_key"]); // the table's full unique key
    }
  });

  it("re-reads once when the row count moves during the read, and uses the stable second read", async () => {
    const a = bigSpend().slice(0, 100);
    const b = bigSpend().slice(0, 101);
    let runs = 0;
    const { admin } = fakeAdmin(() => (++runs <= 2 ? a : b)); // count, page, then the import lands before the second count
    const out = await readSpend(admin, { from: "2026-09-21", to: "2026-10-04" });
    expect(out.reduce((s, r) => s + Math.round(r.spend_php * 100), 0)).toBe(b.reduce((s, r) => s + r.cents, 0));
  });

  it("fails (never a partial number) when it still moves on the re-read", async () => {
    let runs = 0;
    const { admin } = fakeAdmin(() => bigSpend().slice(0, 100 + ++runs));
    await expect(readSpend(admin, { from: "2026-09-21", to: "2026-10-04" })).rejects.toThrow(/changed while it was being read/);
  });
});

describe("loadPatientSourcesDigest", () => {
  it("reads ONE report per period (day grain, served mode) and the spend across both periods", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin, rec } = fakeAdmin(() => []);
    const readAt = new Date("2026-10-05T00:00:00Z");
    const out = await loadPatientSourcesDigest(admin, "week", "2026-10-05", () => readAt);

    expect(loadReport).toHaveBeenCalledTimes(2);
    expect(loadReport).toHaveBeenCalledWith(admin, { from: "2026-09-28", to: "2026-10-04", grain: "day", mode: "served", prev: null });
    expect(loadReport).toHaveBeenCalledWith(admin, { from: "2026-09-21", to: "2026-09-27", grain: "day", mode: "served", prev: null });
    expect(rec.bounds).toContainEqual(["2026-09-21", "2026-10-04"]);
    expect(out).toMatchObject({
      ok: true,
      kind: "data",
      data: { kind: "week", spend: [], spendEverSaved: false, readAt },
    });
    if (out.ok && out.kind === "data") {
      expect(out.data.cur.period).toEqual({ from: "2026-09-28", to: "2026-10-04" });
      expect(out.data.prev?.period).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    }
  });

  it("tells 'nothing ever saved' from 'none this period'", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const old: Row = { spend_date: "2026-01-05", platform: "meta", campaign_key: "c", ad_key: "a", spend_php: 5, cents: 500 };
    const { admin } = fakeAdmin(() => [old]);
    const out = await loadPatientSourcesDigest(admin, "week", "2026-10-05");
    expect(out).toMatchObject({ ok: true, kind: "data", data: { spend: [], spendEverSaved: true } });
  });

  it("makes ONE report call when there is no comparison period", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin } = fakeAdmin(() => []);
    const out = await loadPatientSourcesDigest(admin, "month", "2024-01-01"); // Dec 2023; Nov 2023 would start before the first date
    expect(loadReport).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, kind: "data", data: { prev: null } });
  });

  it("is too_early (no report call at all) when the current period starts before the first date", async () => {
    const { admin } = fakeAdmin(() => []);
    expect(await loadPatientSourcesDigest(admin, "month", "2023-12-15")).toEqual({
      ok: true,
      kind: "too_early",
      period: { from: "2023-11-01", to: "2023-11-30" },
    });
    expect(loadReport).not.toHaveBeenCalled();
  });

  it("fails when either report fails, naming which", async () => {
    const { admin } = fakeAdmin(() => []);
    loadReport.mockResolvedValueOnce({ ok: true, data: report() }).mockResolvedValueOnce({ ok: false, kind: "error", message: "boom" });
    expect(await loadPatientSourcesDigest(admin, "week", "2026-10-05")).toEqual({ ok: false, message: "previous report: boom" });
    loadReport.mockReset();
    loadReport.mockResolvedValueOnce({ ok: false, kind: "error", message: "bad" }).mockResolvedValueOnce({ ok: true, data: report() });
    expect(await loadPatientSourcesDigest(admin, "week", "2026-10-05")).toEqual({ ok: false, message: "report: bad" });
  });

  it("fails (and sends nothing) when the spend read fails", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "gte", "lte", "order", "range", "returns"]) b[m] = () => b;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: null, data: null, error: { message: "nope" } }).then(ok);
        return b;
      },
    } as never;
    const out = await loadPatientSourcesDigest(failing, "week", "2026-10-05");
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("nope");
  });
});

describe("buildPatientSourcesDigestEmail", () => {
  it("renders the email for the period", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin } = fakeAdmin(() => []);
    const out = await buildPatientSourcesDigestEmail(admin, "week", "2026-10-05", "https://drmed.ph");
    expect(out).toMatchObject({ ok: true, kind: "email", period: { from: "2026-09-28", to: "2026-10-04" } });
    if (out.ok && out.kind === "email") {
      expect(out.subject).toBe("Patient sources, Wk of 28 Sep: 12 new (= 0)");
      expect(out.html).toContain("Open Patient Sources");
    }
  });
  it("passes a too_early period and a failure straight through", async () => {
    const { admin } = fakeAdmin(() => []);
    expect(await buildPatientSourcesDigestEmail(admin, "month", "2023-12-15", "https://drmed.ph")).toMatchObject({ ok: true, kind: "too_early" });
    loadReport.mockResolvedValue({ ok: false, kind: "error", message: "down" });
    expect(await buildPatientSourcesDigestEmail(admin, "week", "2026-10-05", "https://drmed.ph")).toMatchObject({ ok: false });
  });
});

describe("never-call list (a refused call crashes prod's Postgres image)", () => {
  const FORBIDDEN = [
    "patient_sources_revenue", "patient_sources_overlaps", "patient_sources_referrers", "patient_sources_people",
    "ad_spend_daily_totals", "ad_spend_coverage", "ad_spend_rows",
  ];
  it.each(["src/lib/marketing/patient-sources-digest.server.ts", "src/lib/marketing/patient-sources-digest.ts"])(
    "%s names none of the admin-only functions",
    (file) => {
      const src = readFileSync(file, "utf8");
      for (const name of FORBIDDEN) expect(src, `${file} names ${name}`).not.toContain(name);
    },
  );
  it("the data module makes no RPC call of its own (the report goes through the shared loader)", () => {
    expect(readFileSync("src/lib/marketing/patient-sources-digest.server.ts", "utf8")).not.toContain(".rpc(");
  });
});
