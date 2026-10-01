# Patient Sources 5a — "as of" stamp + dashboard trend card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every Patient Sources surface with "Numbers as of …", and add an 8-week new-patients trend card (with a cost-per-new-patient overlay once ad spend exists) to the admin dashboard, feeding the "New patients today" tile from the same call.

**Architecture:** Pure helpers in `src/lib/marketing/patient-sources.ts` (stamp text, period maths, trend folding) + one weekday helper in `manila.ts`; one new loader `loadPatientSourcesTrend` in the loader module (the only module allowed to name the RPCs); a new client chart loaded with `next/dynamic({ssr:false})`; dashboard wiring behind a new card id. No SQL.

**Tech Stack:** Next.js 16 (App Router, server components), TypeScript, Supabase JS, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-patient-sources-phase5-design.md` §2 (helpers used by 5a), §3.

**Branch/worktree:** `.worktrees/ps-phase5`, branch `feat/patient-sources-phase5-spec` → rename to `feat/patient-sources-5a` before the first code commit (`git branch -m feat/patient-sources-5a`). It already carries the spec + recon + plans commits.

**Execution notes (from past sessions):** do the small `page.tsx` / `admin-dashboard.tsx` edits directly in the controller — Sonnet implementers stalled twice editing big page files. Sub-agents (Sonnet) for the pure-helper + test tasks are fine. Never run `git stash` bare (shared stash stack).

**Out of 5a (they land in 5b):** `channelDeltas`, `biggestMover`, `sundayObservation`, the digest. 5b rebases on this branch.

---

## File map

| File | Change |
|---|---|
| `src/lib/dates/manila.ts` | + `isoWeekday(iso)` |
| `src/lib/dates/manila.test.ts` (exists? else create `manila-weekday.test.ts`) | tests for `isoWeekday` |
| `src/lib/marketing/patient-sources.ts` | + `asOfLabel`, `lastCompletedWeek`, `previousWeek`, `lastCompletedMonth`, `previousMonth`, `trendWeeks`, `trendCardData`, `TrendCard` type; export `PALETTE` as `CHANNEL_PALETTE` |
| `src/lib/marketing/patient-sources.test.ts` | tests for the above |
| `src/lib/marketing/patient-sources.server.ts` | + `loadPatientSourcesTrend` |
| `src/lib/marketing/patient-sources.server.test.ts` | loader test |
| `src/lib/marketing/patient-sources-surfaces.test.ts` | dashboard surface now also names `loadPatientSourcesTrend` (only if the test requires one loader per surface — see Task 6) |
| `src/lib/reports/csv-response.ts` | + optional `asOf` trailing line |
| `src/lib/reports/csv-response.test.ts` (exists? else create) | trailing-line + rowsExported test |
| `src/app/api/admin/reports/patient-sources.csv/route.ts` + `route.test.ts` | pass `asOf` |
| `src/app/api/admin/reports/patient-sources-people.csv/route.ts` | pass `asOf` |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx` | stamp line |
| `src/app/(staff)/staff/(dashboard)/marketing/sources/page.tsx` | stamp line |
| `src/lib/dashboards/cards.ts` + `cards.test.ts` | + `admin.patient_sources_trend` |
| `src/app/(staff)/staff/(dashboard)/_dashboards/_components/patient-sources-trend-chart.tsx` | new client chart (recharts) |
| `src/app/(staff)/staff/(dashboard)/_dashboards/_components/patient-sources-trend-card.tsx` | new card shell (server-safe) + chart loader |
| `src/app/(staff)/staff/(dashboard)/_dashboards/_components/patient-sources-trend-card.test.tsx` | render tests |
| `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx` | load + render card; tile from the same report |
| `docs/drmed-user-guide.html` | Patient Sources + dashboard paragraphs (version bump at merge time) |

---

### Task 1: `isoWeekday` in manila.ts

**Files:** Modify `src/lib/dates/manila.ts` (after `shiftISODate`, ~line 74); Test: check `ls src/lib/dates/*.test.ts` — add to `manila.test.ts` if it exists, else create `src/lib/dates/manila-weekday.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isoWeekday } from "./manila";

describe("isoWeekday", () => {
  it("returns 0=Sunday … 6=Saturday for a calendar date, independent of the host time zone", () => {
    expect(isoWeekday("2026-10-04")).toBe(0); // Sunday
    expect(isoWeekday("2026-10-05")).toBe(1); // Monday
    expect(isoWeekday("2026-10-10")).toBe(6); // Saturday
    expect(isoWeekday("2024-02-29")).toBe(4); // leap day, Thursday
    expect(isoWeekday("2023-12-31")).toBe(0); // year end, Sunday
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/dates/manila-weekday.test.ts` (or the manila test file) → FAIL (`isoWeekday` is not exported).

- [ ] **Step 3: Implement** — add below `shiftISODate`:

```ts
/**
 * Day of the week of a YYYY-MM-DD calendar date: 0 = Sunday … 6 = Saturday.
 * Built in UTC exactly like `shiftISODate`, so it never depends on the host
 * time zone — the date already IS the Manila calendar day.
 */
export function isoWeekday(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}
```

- [ ] **Step 4: Run** the test → PASS. Also run `npx vitest run src/lib/dates` → all PASS (`manila-usage.test.ts` already allows `getUTCDay` in `lib/dates/manila.ts`, line ~180).

- [ ] **Step 5: Commit** `git add src/lib/dates && git commit -m "feat(dates): isoWeekday for Manila calendar dates"`

---

### Task 2: Stamp + period helpers in patient-sources.ts

**Files:** Modify `src/lib/marketing/patient-sources.ts`; Test `src/lib/marketing/patient-sources.test.ts`.

- [ ] **Step 1: Write the failing tests** (append to `patient-sources.test.ts`; add the new names to its import from `./patient-sources`)

```ts
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
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** — add near `comparisonPeriod` (~line 178); extend the manila import at the top to `daysBetweenISO, isoDateParts, isoWeekday, manilaDateTime, shiftISODate`:

```ts
/** The one stamp every Patient Sources surface shows: when its numbers were read. */
export function asOfLabel(at: Date): string {
  return `Numbers as of ${manilaDateTime(at)}`;
}

export interface Period { from: string; to: string }

/** The Mon–Sun week before the week that contains `todayISO` (Manila calendar dates). */
export function lastCompletedWeek(todayISO: string): Period {
  const sinceMonday = (isoWeekday(todayISO) + 6) % 7;
  const thisMonday = shiftISODate(todayISO, -sinceMonday);
  return { from: shiftISODate(thisMonday, -7), to: shiftISODate(thisMonday, -1) };
}
/** The Mon–Sun week before `p` (p.from is a Monday). */
export function previousWeek(p: Period): Period {
  return lastCompletedWeek(p.from);
}
/** The calendar month before the month that contains `todayISO`. */
export function lastCompletedMonth(todayISO: string): Period {
  const { year, month } = isoDateParts(todayISO);
  const firstThis = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = shiftISODate(firstThis, -1);
  return { from: `${to.slice(0, 8)}01`, to };
}
/** The calendar month before `p` (p.from is the 1st). */
export function previousMonth(p: Period): Period {
  return lastCompletedMonth(p.from);
}
/** `n` completed Mon–Sun weeks ending last Sunday, oldest first. */
export function trendWeeks(todayISO: string, n: number): Period[] {
  const out: Period[] = [lastCompletedWeek(todayISO)];
  while (out.length < n) out.unshift(previousWeek(out[0]));
  return out;
}
```

- [ ] **Step 4: Run** the test file → PASS. Run `npx vitest run src/lib/dates/manila-usage.test.ts src/lib/marketing` → PASS (no inline date formatting added).

- [ ] **Step 5: Commit** `git commit -am "feat(patient-sources): as-of stamp text and week/month period helpers"`

---

### Task 3: `trendCardData` (pure)

**Files:** Modify `src/lib/marketing/patient-sources.ts`; Test `patient-sources.test.ts`.

Rules (spec §3.2): bars from `new_by_day` folded into the 8 weeks; top 5 channels by window total kept (ties → channel key order), the rest folded into `__other` labelled "Other channels" (grey `#94a3b8`), drawn last; every one of the 8 weeks present even when empty; confirmed `__c` and unconfirmed `__u` keys like `chartData` so the hatch pattern carries over; `__cost` = combined cost per new patient for the week (only when that week has spend; omitted otherwise); headline = last week vs the week before; this week so far = new_by_day from the Monday after the last trend week through today.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — rename `const PALETTE` to `export const CHANNEL_PALETTE` (update its one use in `chartData`), then add after `costPerNewPatient`:

```ts
export const OTHER_CHANNELS = { key: "__other", label: "Other channels", color: "#94a3b8" } as const;

export interface TrendCard {
  chart: { rows: ChartDatum[]; channels: ChartChannel[] };
  lastWeek: number;
  weekBefore: number;
  /** Whole-number % change last week vs the week before; null when the week before had nobody. */
  pct: number | null;
  thisWeekSoFar: number;
  hasSpend: boolean;
  ariaLabel: string;
}

/**
 * The admin dashboard's 8-week trend (spec §3.2): new patients per completed
 * Mon–Sun week from the report's `new_by_day`, top 5 channels + "Other", and a
 * combined cost per new patient for weeks that have saved ad spend.
 */
export function trendCardData(newByDay: readonly SeriesRow[], spend: readonly SpendTotalRow[], weeks: readonly Period[], topN = 5): TrendCard {
  const first = weeks[0].from;
  const last = weeks[weeks.length - 1].to;
  const weekOf = (day: string) => weeks.find((w) => day >= w.from && day <= w.to)?.from ?? null;
  const inWindow = newByDay.filter((r) => r.bucket_start >= first && r.bucket_start <= last);
  const ranked = [...totalsByChannel(inWindow).entries()]
    .map(([key, t]) => ({ key, n: t.confirmed + t.unconfirmed }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const kept = new Set(ranked.slice(0, topN).map((c) => c.key));
  const channels: ChartChannel[] = ranked
    .filter((c) => kept.has(c.key))
    .map((c, i) => ({ key: c.key, label: channelLabel(c.key), color: CHANNEL_PALETTE[i % CHANNEL_PALETTE.length] }));
  if (ranked.length > topN) channels.push({ ...OTHER_CHANNELS });

  const rows: ChartDatum[] = weeks.map((w) => {
    const datum: ChartDatum = { bucket: w.from, label: bucketLabel("week", w.from) };
    for (const c of channels) { datum[`${c.key}__c`] = 0; datum[`${c.key}__u`] = 0; }
    return datum;
  });
  const byWeek = new Map(rows.map((r) => [r.bucket, r]));
  for (const r of inWindow) {
    const wk = weekOf(r.bucket_start);
    const datum = wk ? byWeek.get(wk) : undefined;
    if (!datum) continue;
    const key = kept.has(r.channel) ? r.channel : OTHER_CHANNELS.key;
    datum[`${key}__c`] = Number(datum[`${key}__c`]) + Number(r.confirmed);
    datum[`${key}__u`] = Number(datum[`${key}__u`]) + Number(r.unconfirmed);
  }

  let hasSpend = false;
  for (const w of weeks) {
    const wSpend = spend.filter((s) => s.spend_date >= w.from && s.spend_date <= w.to);
    const wNew = inWindow.filter((r) => r.bucket_start >= w.from && r.bucket_start <= w.to);
    const per = costPerNewPatient(wSpend, wNew);
    const spendPhp = per.reduce((a, p) => a + p.spendPhp, 0);
    const people = per.reduce((a, p) => a + p.newConfirmed + p.newUnconfirmed, 0);
    if (spendPhp > 0) {
      hasSpend = true;
      if (people > 0) byWeek.get(w.from)!.__cost = Math.round((spendPhp / people) * 100) / 100;
    }
  }

  const total = (wk: Period) => inWindow
    .filter((r) => r.bucket_start >= wk.from && r.bucket_start <= wk.to)
    .reduce((a, r) => a + Number(r.confirmed) + Number(r.unconfirmed), 0);
  const lastWeek = total(weeks[weeks.length - 1]);
  const weekBefore = weeks.length > 1 ? total(weeks[weeks.length - 2]) : 0;
  const pct = weekBefore > 0 ? Math.round(((lastWeek - weekBefore) / weekBefore) * 100) : null;
  const thisWeekSoFar = newByDay
    .filter((r) => r.bucket_start > last)
    .reduce((a, r) => a + Number(r.confirmed) + Number(r.unconfirmed), 0);
  const change = pct === null ? "nobody the week before" : pct === 0 ? "the same as the week before"
    : `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the week before`;
  return {
    chart: { rows, channels }, lastWeek, weekBefore, pct, thisWeekSoFar, hasSpend,
    ariaLabel: `New patients per week for ${weeks.length} weeks. Last week ${lastWeek}, ${change}.`,
  };
}
```

(`Period` comes from Task 2; `totalsByChannel`, `channelLabel`, `bucketLabel`, `costPerNewPatient` already live in this file.)

- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit -p .` → no errors (CHANNEL_PALETTE rename compiles everywhere).

- [ ] **Step 5: Commit** `git commit -am "feat(patient-sources): trendCardData folds new_by_day into 8 weekly bars with cost overlay"`

---

### Task 4: `loadPatientSourcesTrend` loader

**Files:** Modify `src/lib/marketing/patient-sources.server.ts`; Test `patient-sources.server.test.ts`.

- [ ] **Step 1: Write the failing test** (append; add `loadPatientSourcesTrend` to the import)

```ts
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
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources.server.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add `trendWeeks, type Period` to the import from `./patient-sources`, then below `loadNewPatientsToday`:

```ts
export interface PatientSourcesTrend {
  weeks: Period[];
  newByDay: SeriesRow[];
  spend: { ok: true; rows: SpendTotalRow[] } | { ok: false };
  /** ISO instant the report was read — the card's "as of" stamp. */
  readAt: string;
  todayISO: string;
}

/**
 * The admin dashboard trend card (spec §3.2): ONE report call over the 8
 * completed weeks through today (its `new_by_day` feeds the bars, "this week
 * so far" and today's tile), plus saved ad spend over the 8 weeks. An admin
 * session on the admin-only dashboard — never call this with the service key
 * (ad_spend_daily_totals refuses it; a refused call crashes prod's image).
 */
export async function loadPatientSourcesTrend(supabase: Db, todayISO: string): Promise<ReportResult<PatientSourcesTrend>> {
  const weeks = trendWeeks(todayISO, 8);
  const [report, spend] = await Promise.all([
    loadPatientSourcesReport(supabase, { from: weeks[0].from, to: todayISO, grain: "week", mode: "new", prev: null }),
    loadAdSpendTotals(supabase, weeks[0].from, weeks[weeks.length - 1].to),
  ]);
  if (!report.ok) return report;
  return {
    ok: true,
    data: {
      weeks,
      newByDay: report.data.new_by_day,
      spend: spend.ok ? { ok: true, rows: spend.data.rows } : { ok: false },
      readAt: new Date().toISOString(),
      todayISO,
    },
  };
}
```

- [ ] **Step 4: Run** → PASS; also `npx vitest run src/lib/marketing/patient-sources-surfaces.test.ts` → PASS (no new RPC names outside the loader module).

- [ ] **Step 5: Commit** `git commit -am "feat(patient-sources): loadPatientSourcesTrend — one report call for the dashboard trend"`

---

### Task 5: CSV `asOf` trailing line

**Files:** Modify `src/lib/reports/csv-response.ts`, both Patient Sources CSV routes, `src/app/api/admin/reports/patient-sources.csv/route.test.ts`.

- [ ] **Step 1: Write the failing test** — in `patient-sources.csv/route.test.ts`, find how `reportCsvResponse` is mocked (`sent.rows` assertion ~line 106) and add:

```ts
it("stamps the export with when the numbers were read, outside the data rows", async () => {
  // reuse the file's existing happy-path arrange (report mock resolves ok)
  const res = await GET(req("/api/admin/reports/patient-sources.csv?from=2026-06-01&to=2026-06-30"));
  expect(res.status).toBe(200);
  expect(sent.asOf).toMatch(/^Numbers as of /);
  expect(sent.rows).toEqual(seriesCsvRows(/* same args as the existing assertion */));
});
```

(Match the file's real helper names — `req`, `sent`, the mocked `reportCsvResponse` capture — when writing it; the shape above is the contract: `asOf` is a separate argument, `rows` unchanged.)

If `src/lib/reports/csv-response.test.ts` exists, add there (else create it, mocking `@/lib/audit/log` and `@/lib/server/action-helpers` the way sibling route tests do):

```ts
it("writes asOf as the last line and does not count it as an exported row", async () => {
  const res = await reportCsvResponse({ staff, report: "x", filename: "x.csv",
    rows: [["h"], ["1"], ["2"]], truncated: true, filters: {}, asOf: "Numbers as of Oct 1, 2026, 9:14 AM" });
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  expect(lines.at(-1)).toContain("Numbers as of Oct 1, 2026, 9:14 AM");
  expect(lines.at(-2)).toContain("TRUNCATED");
  expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rows_exported: 2 }) }));
});
```

(Check `reportExportMetadata` for the real metadata key name for rows exported and use it.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — in `reportCsvResponse` args add `/** "Numbers as of …" — written as the LAST line, never counted as a row. */ asOf?: string;` and after the truncation push:

```ts
  if (args.asOf) body.push([args.asOf]);
```

In `patient-sources.csv/route.ts`: import `asOfLabel` and pass `asOf: asOfLabel(new Date())` (computed right after `loadPatientSourcesReport` resolves — declare `const readAt = new Date();` on the line after the `if (!report.ok)` return). In `patient-sources-people.csv/route.ts`: same, after `loadAllPeople` resolves.

- [ ] **Step 4: Run** `npx vitest run src/lib/reports src/app/api/admin/reports` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(reports): Patient Sources CSVs end with a 'Numbers as of' line"`

---

### Task 6: Page stamps (controller edits directly)

**Files:** `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx`, `src/app/(staff)/staff/(dashboard)/marketing/sources/page.tsx`.

- [ ] **Step 1: Patient Sources** — import `asOfLabel` from `@/lib/marketing/patient-sources`. Immediately after the `const [report, spend, coverage] = await Promise.all([...])` add `const readAt = new Date();`. In the "Last sync" paragraph (`<p className="mt-2 text-xs …">` after the StatCard grid), append as its last child:

```tsx
        {` ${asOfLabel(readAt)}.`}
```

- [ ] **Step 2: Booking Sources** — import `asOfLabel` from `@/lib/marketing/patient-sources`; after its `] = await Promise.all([` … `]);` (~line 74) add `const readAt = new Date();`; directly after the `<PeriodControls … />` element add:

```tsx
      <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">{asOfLabel(readAt)}</p>
```

- [ ] **Step 3: Run** `npx vitest run src/lib/dates/manila-usage.test.ts src/lib/marketing` and `npx tsc --noEmit` → PASS (`date-render-surfaces.test.ts` too: `npx vitest run -t "date"` if unsure of its path — `git grep -l date-render-surfaces`).

- [ ] **Step 4: Commit** `git commit -am "feat(patient-sources): 'Numbers as of' stamp on Patient Sources and Booking Sources"`

---

### Task 7: Card id + trend chart + card component

**Files:** `src/lib/dashboards/cards.ts`, `cards.test.ts`; Create `_dashboards/_components/patient-sources-trend-chart.tsx`, `patient-sources-trend-card.tsx`, `patient-sources-trend-card.test.tsx`.

- [ ] **Step 1: Card registry** — in `cards.ts` People group, after `admin.new_patients_today`:

```ts
  { id: "admin.patient_sources_trend",   label: "New patients — 8-week trend", roles: ["admin"], group: "people" },
```

Run `npx vitest run src/lib/dashboards` — if `cards.test.ts` pins the id list/count, update it to include the new id; re-run → PASS.

- [ ] **Step 2: Write the failing card test** `patient-sources-trend-card.test.tsx` (check a sibling `*.test.tsx` under `_dashboards` or `marketing/patients/_components` for the render helper — `@testing-library/react` `render`/`screen` — and copy its setup):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("./patient-sources-trend-chart-loader", () => ({ PatientSourcesTrendChartLoader: () => <div data-testid="chart" /> }));
import { PatientSourcesTrendCard } from "./patient-sources-trend-card";
import { trendCardData, trendWeeks } from "@/lib/marketing/patient-sources";

const weeks = trendWeeks("2026-10-01", 8);
const ok = (spend: { ok: true; rows: never[] } | { ok: false } = { ok: true, rows: [] }) => ({
  ok: true as const,
  data: { weeks, newByDay: [{ bucket_start: "2026-09-22", channel: "walk_in", confirmed: 3, unconfirmed: 0 }], spend,
    readAt: "2026-10-01T01:14:00Z", todayISO: "2026-10-01" },
});

describe("PatientSourcesTrendCard", () => {
  it("shows the headline, this week so far, the stamp and the no-spend footnote", () => {
    render(<PatientSourcesTrendCard trend={ok()} />);
    expect(screen.getByText(/Last week/)).toHaveTextContent("Last week 3");
    expect(screen.getByText(/none the week before/)).toBeInTheDocument();
    expect(screen.getByText(/This week so far: 0/)).toBeInTheDocument();
    expect(screen.getByText(/Numbers as of/)).toBeInTheDocument();
    expect(screen.getByText(/appears once ad spend is saved/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Patient Sources/ })).toHaveAttribute(
      "href", "/staff/marketing/patients?from=2026-08-03&to=2026-09-27&grain=week&mode=new");
    expect(screen.getByRole("img", { name: /Last week 3/ })).toBeInTheDocument();
  });
  it("says when ad spend could not be loaded", () => {
    render(<PatientSourcesTrendCard trend={ok({ ok: false })} />);
    expect(screen.getByText(/Couldn.t load ad spend/)).toBeInTheDocument();
  });
  it("degrades to the standard couldn't-load state when the report failed", () => {
    render(<PatientSourcesTrendCard trend={{ ok: false, kind: "error", message: "x" }} />);
    expect(screen.getByText(/Couldn.t load/)).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
  });
  it("trendCardData is what the card draws", () => {
    expect(trendCardData(ok().data.newByDay, [], weeks).lastWeek).toBe(3);
  });
});
```

(Use the real `ReportResult` failure shape from `patient-sources.ts` — check `classifyReportError`'s return type for the field names.)

- [ ] **Step 3: Run** → FAIL (modules missing).

- [ ] **Step 4: Implement the chart** `patient-sources-trend-chart.tsx`:

```tsx
"use client";
/**
 * Dashboard trend (spec §3.2): stacked weekly bars per channel (solid =
 * confirmed, hatched = unconfirmed, as on Patient Sources) and, when ad spend
 * is saved, a cost-per-new-patient line on a second axis. Loaded through
 * patient-sources-trend-chart-loader so recharts stays out of the first bundle.
 */
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

export function PatientSourcesTrendChart({ rows, channels, hasSpend }: { rows: ChartDatum[]; channels: ChartChannel[]; hasSpend: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={rows} margin={{ top: 8, right: hasSpend ? 0 : 8, bottom: 0, left: 0 }}>
        <defs>
          {channels.map((c) => (
            <pattern key={c.key} id={`trend-hatch-${c.key}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="white" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={c.color} strokeWidth="3" />
            </pattern>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
        <YAxis yAxisId="n" allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
        {hasSpend ? <YAxis yAxisId="php" orientation="right" tick={{ fontSize: 10 }} width={44} tickFormatter={(v: number) => `₱${v}`} /> : null}
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {channels.flatMap((c) => [
          <Bar key={`${c.key}-c`} yAxisId="n" dataKey={`${c.key}__c`} name={c.label} stackId="s" fill={c.color} />,
          <Bar key={`${c.key}-u`} yAxisId="n" dataKey={`${c.key}__u`} name={`${c.label} (unconfirmed)`} stackId="s" fill={`url(#trend-hatch-${c.key})`} legendType="none" />,
        ])}
        {hasSpend ? (
          <Line yAxisId="php" type="monotone" dataKey="__cost" name="Cost per new patient (₱)" stroke="#0f172a" strokeWidth={2} dot connectNulls={false} />
        ) : null}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
```

and the loader `patient-sources-trend-chart-loader.tsx`:

```tsx
"use client";
import dynamic from "next/dynamic";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

const Chart = dynamic(() => import("./patient-sources-trend-chart").then((m) => m.PatientSourcesTrendChart), {
  ssr: false,
  loading: () => <div className="h-[220px] animate-pulse rounded bg-[color:var(--color-brand-bg)]" />,
});

export function PatientSourcesTrendChartLoader(props: { rows: ChartDatum[]; channels: ChartChannel[]; hasSpend: boolean }) {
  return <Chart {...props} />;
}
```

- [ ] **Step 5: Implement the card** `patient-sources-trend-card.tsx` (no "use client" — rendered by the server dashboard; the loader is the client boundary):

```tsx
import Link from "next/link";
import { asOfLabel, trendCardData, type ReportResult } from "@/lib/marketing/patient-sources";
import type { PatientSourcesTrend } from "@/lib/marketing/patient-sources.server";
import { StatCard } from "./stat-card";
import { PatientSourcesTrendChartLoader } from "./patient-sources-trend-chart-loader";

const LABEL = "New patients — last 8 weeks";

export function PatientSourcesTrendCard({ trend }: { trend: ReportResult<PatientSourcesTrend> }) {
  if (!trend.ok) return <StatCard label={LABEL} value={0} error />;
  const { weeks, newByDay, spend, readAt } = trend.data;
  const t = trendCardData(newByDay, spend.ok ? spend.rows : [], weeks);
  const href = `/staff/marketing/patients?from=${weeks[0].from}&to=${weeks[weeks.length - 1].to}&grain=week&mode=new`;
  const change = t.pct === null ? "(none the week before)" : `${t.pct > 0 ? "▲" : t.pct < 0 ? "▼" : "="} ${Math.abs(t.pct)}% vs the week before`;
  return (
    <section className="relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-[color:var(--color-brand-cyan)] sm:col-span-2">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">{LABEL}</p>
      <p className="mt-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Last week {t.lastWeek.toLocaleString("en-PH")} <span className="text-sm font-bold">{change}</span>
      </p>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">This week so far: {t.thisWeekSoFar.toLocaleString("en-PH")}</p>
      <div role="img" aria-label={t.ariaLabel} className="mt-3">
        <PatientSourcesTrendChartLoader rows={t.chart.rows} channels={t.chart.channels} hasSpend={t.hasSpend} />
      </div>
      <table className="sr-only">
        <caption>New patients per week by channel</caption>
        <thead><tr><th>Week</th>{t.chart.channels.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {t.chart.rows.map((r) => (
            <tr key={r.bucket}>
              <td>{r.label}</td>
              {t.chart.channels.map((c) => <td key={c.key}>{Number(r[`${c.key}__c`]) + Number(r[`${c.key}__u`])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!spend.ok ? (
        <p className="mt-2 text-xs text-amber-800">Couldn&apos;t load ad spend — cost per new patient is not shown.</p>
      ) : !t.hasSpend ? (
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Cost per new patient appears once ad spend is saved (Ad Performance → Save them to clinic records).
        </p>
      ) : null}
      <p className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[color:var(--color-brand-text-soft)]">
        <span>{asOfLabel(new Date(readAt))}</span>
        <Link href={href} className="font-bold text-[color:var(--color-brand-navy)] underline">Open Patient Sources →</Link>
      </p>
    </section>
  );
}
```

- [ ] **Step 6: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/_dashboards" src/lib/dashboards` → PASS.

- [ ] **Step 7: Commit** `git add -A src && git commit -m "feat(dashboard): Patient Sources 8-week trend card"`

---

### Task 8: Dashboard wiring + tile from the same report (controller edits directly)

**Files:** `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx`, `src/lib/marketing/patient-sources-surfaces.test.ts` (only if needed), a small pure helper + test.

- [ ] **Step 1: Pure helper + failing test** — in `patient-sources.ts`:

```ts
/** Today's rows out of a trend's new_by_day — what loadNewPatientsToday returns for the same day. */
export function todayRows(newByDay: readonly SeriesRow[], todayISO: string): SeriesRow[] {
  return newByDay.filter((r) => r.bucket_start === todayISO);
}
```

test:

```ts
it("todayRows gives the tile the same rows the single-day call would", () => {
  const rows = [
    { bucket_start: "2026-09-30", channel: "walk_in", confirmed: 1, unconfirmed: 0 },
    { bucket_start: "2026-10-01", channel: "walk_in", confirmed: 2, unconfirmed: 1 },
    { bucket_start: "2026-10-01", channel: "online_google", confirmed: 1, unconfirmed: 0 },
  ];
  expect(formatNewToday(todayRows(rows, "2026-10-01"))).toEqual(formatNewToday(rows.slice(1)));
});
```

Run → FAIL, implement, run → PASS.

- [ ] **Step 2: Load** — in `loadAdminStats`, add `trend` to the destructured array (after `newToday`) and replace the `newToday` promise with:

```ts
    show("admin.new_patients_today") && !show("admin.patient_sources_trend")
      ? loadNewPatientsToday(supabase, today)
      : Promise.resolve(null),
    show("admin.patient_sources_trend")
      ? loadPatientSourcesTrend(supabase, today)
      : Promise.resolve(null),
```

and in the returned stats object:

```ts
    // With the trend card on, the tile reads today's rows from the trend's one
    // report call (identical by construction: same _ps_sec_series day/new).
    newToday: (trend
      ? (trend.ok ? { ok: true as const, data: todayRows(trend.data.newByDay, today) } : trend)
      : newToday) as ReportResult<SeriesRow[]> | null,
    trend: trend as ReportResult<PatientSourcesTrend> | null,
```

Imports: `loadPatientSourcesTrend, type PatientSourcesTrend` from the server module; `todayRows` from `patient-sources`.

- [ ] **Step 3: Render** — `showPeople` gains `|| show("admin.patient_sources_trend")`; inside the People grid, after the "New patients today" StatCard:

```tsx
            {show("admin.patient_sources_trend") && stats.trend && (
              <PatientSourcesTrendCard trend={stats.trend} />
            )}
```

with `import { PatientSourcesTrendCard } from "./_components/patient-sources-trend-card";`. The card's `sm:col-span-2` lets it span two grid columns.

- [ ] **Step 4: Surfaces test** — run `npx vitest run src/lib/marketing/patient-sources-surfaces.test.ts`. If it asserts each surface names exactly its listed loader, keep `loadNewPatientsToday` for the dashboard (still imported) — it should pass unchanged. If it fails, change the dashboard entry to the loader it now names first, with a comment.

- [ ] **Step 5: Run the gate** `npm test && npm run typecheck && npm run lint && npm run build` (capture output to a file in the scratchpad; report only failures) → all PASS.

- [ ] **Step 6: Commit** `git commit -am "feat(dashboard): trend card wired; New patients today reads the same report"`

---

### Task 9: Guide + browser smoke

- [ ] **Step 1: Guide** — `docs/drmed-user-guide.html`: in the Patient Sources section add one sentence: "The line under the cards says when the numbers were read (Numbers as of …); the CSV ends with the same line." In the admin dashboard section add: "New patients — last 8 weeks: weekly bars by channel (top 5 + Other), last week vs the week before, this week so far; a cost-per-new-patient line appears once ad spend is saved on Ad Performance. Hide it from Customise dashboard." Do NOT bump the version now (bumped at merge time).

- [ ] **Step 2: Browser smoke** (Playwright MCP; authed local dev on :4000 per CLAUDE.md, or the cookie-injection recipe; text checks first, one screenshot of the card):
  - `/staff/marketing/patients` — stamp text present (`browser_evaluate` → `document.body.innerText.includes("Numbers as of")`).
  - `/staff/marketing/sources` — stamp present.
  - `/staff` (admin dashboard) — card heading "New patients — last 8 weeks", 8 x-axis labels, no console errors; one screenshot.
  - Download the CSV (fetch via `browser_evaluate`) — last line starts "Numbers as of".

- [ ] **Step 3: Commit** `git commit -am "docs(guide): as-of stamp and dashboard trend card"`

- [ ] **Step 4: Review gate** — dispatch a Sonnet code reviewer (superpowers:code-reviewer) over `git diff origin/main...HEAD` against spec §2–§3; fix confirmed findings; re-run the gate.

- [ ] **Step 5: PR** — push, open the PR (body: what/why, owner-visible changes, no migration, test evidence, "0 ad spend rows on prod → no cost line yet"), ask the user before merging; at merge time bump the guide version; after merge confirm the Vercel production deploy is READY.
