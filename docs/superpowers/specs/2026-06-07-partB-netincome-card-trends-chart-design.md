# Part B — Net Income dashboard card + first Trends chart — design

**Date:** 2026-06-07
**Status:** Approved 2026-06-07 — ready for implementation plan
**Context:** Two follow-on additions to B1.3 ([[project-ops-analytics-dashboard]]),
built on the same branch (`feat/partB-b1.3-expenses`, PR #50). Both surface the
B1.3 operational net income elsewhere in the app. Parent specs:
`2026-06-07-partB-b1.3-expenses-net-income-design.md` (the P&L definition) and
`2026-06-05-partB-daily-report-design.md` (the views).

## Goal

1. **Net income card** — surface this-month operational net income as a card on the
   admin dashboard's **Money** section, linking to the Expenses & P&L tab.
2. **First Trends chart** — replace the Trends tab's "coming soon" stub with one
   monthly chart: gross profit vs total expenses (bars) + net income (line), over
   all history, using `recharts`.

Both reuse the **same operational definition** as the B1.3 tab so the tab, the card,
and the chart agree to the peso:

> **gross profit** = lab + consult net (`Σ v_ops_daily_totals.net`) ·
> **expenses** = `Σ v_ops_daily_expenses.expense_php` ·
> **net income** = gross profit − expenses

No schema change, no new views — `v_ops_daily_totals` (0093) and
`v_ops_daily_expenses` (0094) are already live on prod. Grounding verified
2026-06-07: the totals view has exactly two sections (`lab`, `consult`), so summing
its `net` column over any range equals the tab's gross profit (which
`buildDailyMatrix(...).totals.net` produces by summing all totals rows).

## Piece 1 — "Net income (this month)" admin-dashboard card

### Card registry — `src/lib/dashboards/cards.ts`
Add one entry to `DASHBOARD_CARDS`, in the **Admin: Money** block:

```ts
{ id: "admin.net_income_mtd", label: "Net income (this month)", roles: ["admin"], group: "money", sensitive: true },
```

`sensitive: true` (it is a clinic-wide financial figure, like `admin.revenue_today`).
The new id auto-appears in the dashboard-card show/hide settings, shown by default
(a card is hidden only if its id is in `dashboard_card_prefs`).

### Data load — `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx`
In `loadAdminStats(show)`, add two `show("admin.net_income_mtd")`-gated reads to the
existing `Promise.all`, over the current month (`monthStart = ${today.slice(0,7)}-01`
→ `today`), using the already-constructed `admin` (service-role) client:

```ts
show("admin.net_income_mtd")
  ? admin.from("v_ops_daily_totals").select("net").gte("business_date", monthStart).lte("business_date", today).returns<{ net: number | string }[]>()
  : SKIP_DATA,
show("admin.net_income_mtd")
  ? admin.from("v_ops_daily_expenses").select("expense_php").gte("business_date", monthStart).lte("business_date", today).returns<{ expense_php: number | string }[]>()
  : SKIP_DATA,
```

Compute and return `netIncomeMtd = Σ net − Σ expense_php` (coerce with `Number(... ?? 0)`,
matching the file's existing reduce idiom). No section filter needed (only lab+consult
rows exist); summing all rows is correct and matches the tab.

### Render — Money section `StatCard`
Place near the top of the **Money** `SectionHeading` grid:

```tsx
{show("admin.net_income_mtd") && (
  <StatCard
    label="Net income (this month)"
    value={formatPeso(stats.netIncomeMtd)}
    hint="Gross profit − expenses, month to date"
    href="/staff/admin/operations/expenses"
    accent={stats.netIncomeMtd >= 0 ? "good" : "warn"}
  />
)}
```

Green when profitable, amber on a loss. Links to the Expenses & P&L tab.

## Piece 2 — Trends tab: monthly P&L chart

### Dependency
`npm install recharts` (latest `^3`; React-19 / Next-16 compatible, verified
2026-06-07: recharts 3.8.1 peer `react: ^19.0.0`). recharts is client-only.

### Pure core — `src/lib/operations/trends.ts` (+ `.test.ts`, vitest, no `server-only`)
Reuses `num` from `./daily-report`.

```ts
export interface MonthlyPnlRow {
  month: string;   // "YYYY-MM" sort key
  label: string;   // "Dec 2023" display
  grossProfit: number;
  expenses: number;
  net: number;
}
export function buildMonthlyPnl(
  totalsRows: { business_date: string | null; net: number | string | null }[],
  expenseRows: { business_date: string | null; expense_php: number | string | null }[],
): MonthlyPnlRow[];
```

Rolls each view row up by `business_date.slice(0,7)`; `grossProfit` from totals,
`expenses` from the expenses view, `net = grossProfit − expenses`; output sorted
ascending by `month`. `label` = `"MMM YYYY"` (en-PH). Rows with a null
`business_date` are skipped. Tested: rollup across multiple days into one month,
two months ordered, `net = gross − exp`, empty input → `[]`.

### Page — `trends/page.tsx` (replaces the stub)
Server Component: `requireAdminStaff()` → `createAdminClient()` → parallel-fetch
`v_ops_daily_totals` (`select business_date, net`) + `v_ops_daily_expenses`
(`select business_date, expense_php`) over **all history** (no range filter —
Dec 2023 → today, ~1.5k rows) → `buildMonthlyPnl` → render. Keep `OperationsTabs`
and the `Operations` heading. On any fetch error: the short error-card pattern (no
stack traces). When the result is empty: `EmptyState`. No date controls this pass
(deferred to the full B2 pack).

### Chart — `trends/_components/pnl-trend-chart.tsx` (`'use client'`)
recharts `ComposedChart` inside a shadcn `Card`, wrapped in `ResponsiveContainer`
(width 100%, height ~320):
- `<Bar dataKey="grossProfit" name="Gross profit">` — navy (`var(--color-brand-navy)`).
- `<Bar dataKey="expenses" name="Expenses">` — muted red.
- `<Line dataKey="net" name="Net income">` — accent, dots on.
- `<XAxis dataKey="label">`, `<YAxis>` with a compact PHP tick formatter (e.g.
  `₱1.2M` / `₱120k`), `<Tooltip>` + `<Legend>` with a full en-PH PHP formatter.
- Mobile-safe (390×844): `ResponsiveContainer` handles width; abbreviated y ticks
  and angled/!interval x labels keep it readable with ~30 months.

The Trends tab already exists in `operations-tabs.tsx` — no tab change needed.

## Data flow
Both surfaces: Server Component → `createAdminClient()` (read-only) → read the two
live views → aggregate in JS (inline sum for the card; pure `buildMonthlyPnl` for the
chart) → render. No Server Actions, no writes, admin-only.

## Testing
- **vitest** `trends.test.ts` (~4 tests) — rollup, ordering, `net = gross − exp`,
  empty input. Total suite 167 → ~171.
- typecheck + lint clean (only the pre-existing `clinical-backfill/engine.ts:81` +
  2 unused-import warnings, untouched). The dashboard route + the Trends route both
  compile under Next 16; Trends 307-redirects via `requireAdminStaff` unauthenticated.
- **Reconciliation (smoke):** the card's MTD net income must equal the Expenses &
  P&L tab's MTD net income (set the tab range to the current month); the chart's
  current-month net bar must equal the same figure.

## Out of scope (deferred to the full B2 Trends pack)
- Date-range controls on Trends, per-doctor / per-channel / specialty charts,
  marketing-growth charts, multiple chart types, CSV/PNG export of the chart.
- A monthly SQL view / materialization (the daily views roll up fine in JS at this
  volume).
- Surfacing net income for any period other than this-month on the dashboard.
- Touching the B1.3 tab itself (already shipped on this branch / PR #50).
