# Net Income card + first Trends chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface B1.3 operational net income in two new places — a "Net income (this month)" card on the admin dashboard, and a first monthly Revenue-vs-Expenses-vs-Net chart on the Operations → Trends tab.

**Architecture:** Both reuse the live B1.3 views (`v_ops_daily_totals` for gross profit = lab+consult net, `v_ops_daily_expenses` for expenses; net = gross − expenses) — no schema change, no new views. The card is an inline sum inside the existing admin-dashboard loader; the chart is a vitest-tested pure monthly-rollup core + a `recharts` client component behind a Server-Component page.

**Tech Stack:** Next.js 16 (App Router, RSC), Supabase admin (service-role) client, TypeScript strict, vitest, shadcn `ui/*`, `recharts@^3` (new dep, React-19 compatible), en-PH PHP formatting.

**Spec:** `docs/superpowers/specs/2026-06-07-partB-netincome-card-trends-chart-design.md`

**Branch:** `feat/partB-b1.3-expenses` (already checked out — extends PR #50).

**Model guidance:** Opus main loop (orchestration + recharts install + verification + PR update); **Sonnet** for the mechanical implementer subagents (Tasks 1, 2, 4).

---

## Dispatch 1 — Net income card (no new dependency)

### Task 1: "Net income (this month)" admin-dashboard card

**Files:**
- Modify: `src/lib/dashboards/cards.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx`

- [ ] **Step 1: Register the card** — in `src/lib/dashboards/cards.ts`, in the `// ---- Admin: Money ----` block of `DASHBOARD_CARDS`, add this as the FIRST entry of that block (immediately after the comment line, before `admin.past_due_periods`):

```ts
  { id: "admin.net_income_mtd",        label: "Net income (this month)",  roles: ["admin"], group: "money", sensitive: true },
```

- [ ] **Step 2: Add the month-start date constant** — in `admin-dashboard.tsx`, inside `loadAdminStats`, immediately after the line `const today = todayManilaISODate();` add:

```ts
  const monthStart = `${today.slice(0, 7)}-01`;
```

- [ ] **Step 3: Add the two gated reads** — in `loadAdminStats`, append these TWO entries to the END of the `Promise.all([...])` array (after the existing last entry `staleDrafts`'s query — i.e. after the `show("admin.strip_stale_drafts") ? ... : SKIP_DATA,` entry). Keep the trailing comma style:

```ts
    show("admin.net_income_mtd")
      ? admin
          .from("v_ops_daily_totals")
          .select("net")
          .gte("business_date", monthStart)
          .lte("business_date", today)
          .returns<{ net: number | string }[]>()
      : SKIP_DATA,
    show("admin.net_income_mtd")
      ? admin
          .from("v_ops_daily_expenses")
          .select("expense_php")
          .gte("business_date", monthStart)
          .lte("business_date", today)
          .returns<{ expense_php: number | string }[]>()
      : SKIP_DATA,
```

  And add the two matching names to the END of the destructuring array (the `const [ ... ] = await Promise.all(...)`), after `staleDrafts`:

```ts
    netTotalsMtd,
    netExpensesMtd,
```

- [ ] **Step 4: Compute the figure** — in `loadAdminStats`, after the existing `doctorsToPayTotal` computation and before the `return {` statement, add:

```ts
  const netIncomeMtd =
    ((netTotalsMtd.data ?? []) as { net: number | string }[]).reduce(
      (s, r) => s + Number(r.net ?? 0),
      0,
    ) -
    ((netExpensesMtd.data ?? []) as { expense_php: number | string }[]).reduce(
      (s, r) => s + Number(r.expense_php ?? 0),
      0,
    );
```

  And add `netIncomeMtd,` to the returned object (anywhere in the `return { ... }` block, e.g. right after `doctorsToPayCount,`).

- [ ] **Step 5: Render the card** — in the `AdminDashboard` component's `<SectionHeading title="Money">` grid, add this as the FIRST card inside the grid `<div>` (before the `admin.past_due_periods` `StatCard`):

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

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/dashboards/cards.ts "src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx"
git commit -m "feat(ops): admin dashboard 'Net income (this month)' card"
```

---

## Dispatch 2 — Trends monthly P&L chart

### Task 2: `trends.ts` — `buildMonthlyPnl` pure core (TDD)

**Files:**
- Create: `src/lib/operations/trends.ts`
- Test: `src/lib/operations/trends.test.ts`

- [ ] **Step 1: Write the failing test** (`src/lib/operations/trends.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildMonthlyPnl } from "./trends";

describe("buildMonthlyPnl", () => {
  it("rolls daily rows up into months: net = grossProfit − expenses", () => {
    const totals = [
      { business_date: "2023-12-01", net: 5000 },
      { business_date: "2023-12-15", net: 3000 },
      { business_date: "2024-01-10", net: 2000 },
    ];
    const expenses = [
      { business_date: "2023-12-02", expense_php: 1000 },
      { business_date: "2024-01-05", expense_php: 800 },
    ];
    const out = buildMonthlyPnl(totals, expenses);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ month: "2023-12", label: "Dec 2023", grossProfit: 8000, expenses: 1000, net: 7000 });
    expect(out[1]).toEqual({ month: "2024-01", label: "Jan 2024", grossProfit: 2000, expenses: 800, net: 1200 });
  });

  it("sorts months chronologically regardless of input order", () => {
    const out = buildMonthlyPnl(
      [{ business_date: "2024-03-01", net: 1 }, { business_date: "2024-01-01", net: 1 }],
      [],
    );
    expect(out.map((r) => r.month)).toEqual(["2024-01", "2024-03"]);
  });

  it("skips rows with a null business_date", () => {
    const out = buildMonthlyPnl(
      [{ business_date: null, net: 999 }, { business_date: "2024-02-01", net: 10 }],
      [{ business_date: null, expense_php: 999 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].grossProfit).toBe(10);
    expect(out[0].expenses).toBe(0);
  });

  it("returns [] for empty input", () => {
    expect(buildMonthlyPnl([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/operations/trends.test.ts`
Expected: FAIL ("Cannot find module './trends'").

- [ ] **Step 3: Write the implementation** (`src/lib/operations/trends.ts`):

```ts
// Pure monthly P&L rollup for the Operations Trends chart (first B2 chart).
// NO "server-only" import — vitest-tested + consumed by the Trends Server Component.
import { num } from "./daily-report";

export interface MonthlyPnlRow {
  month: string; // "YYYY-MM" sort key
  label: string; // "Dec 2023" display
  grossProfit: number;
  expenses: number;
  net: number;
}

interface DatedNet {
  business_date: string | null;
  net: number | string | null;
}
interface DatedExpense {
  business_date: string | null;
  expense_php: number | string | null;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

export function buildMonthlyPnl(
  totalsRows: DatedNet[],
  expenseRows: DatedExpense[],
): MonthlyPnlRow[] {
  const byMonth = new Map<string, { grossProfit: number; expenses: number }>();
  const ensure = (month: string) => {
    let row = byMonth.get(month);
    if (!row) {
      row = { grossProfit: 0, expenses: 0 };
      byMonth.set(month, row);
    }
    return row;
  };

  for (const r of totalsRows) {
    if (!r.business_date) continue;
    ensure(r.business_date.slice(0, 7)).grossProfit += num(r.net);
  }
  for (const r of expenseRows) {
    if (!r.business_date) continue;
    ensure(r.business_date.slice(0, 7)).expenses += num(r.expense_php);
  }

  return [...byMonth.keys()].sort().map((month) => {
    const { grossProfit, expenses } = byMonth.get(month)!;
    return { month, label: monthLabel(month), grossProfit, expenses, net: grossProfit - expenses };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/operations/trends.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/trends.ts src/lib/operations/trends.test.ts
git commit -m "feat(ops): monthly P&L rollup pure core for Trends chart"
```

---

### Task 3: Install `recharts` (orchestrator)

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install** (orchestrator)

Run: `npm install recharts`
Expected: adds `recharts` (^3.x) to `dependencies`; no peer-dependency ERESOLVE error (recharts 3 supports React 19). Note any deprecation warnings but they are non-blocking.

- [ ] **Step 2: Sanity-check the install**

Run: `node -e "console.log(require('recharts/package.json').version)"`
Expected: prints a `3.x.y` version.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add recharts for operations trend charts"
```

---

### Task 4: Trends page + chart component

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/operations/trends/_components/pnl-trend-chart.tsx`
- Modify (replace stub): `src/app/(staff)/staff/(dashboard)/admin/operations/trends/page.tsx`

- [ ] **Step 1: Write the chart component** (`trends/_components/pnl-trend-chart.tsx`):

```tsx
"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { MonthlyPnlRow } from "@/lib/operations/trends";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(n);

const compactPeso = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `₱${Math.round(n / 1_000)}k`;
  return `₱${n}`;
};

export function PnlTrendChart({ data }: { data: MonthlyPnlRow[] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        className="mt-6"
        title="No data to chart yet"
        description="There are no posted expenses or revenue in the books."
      />
    );
  }

  return (
    <Card className="mt-4 px-2 py-4 sm:px-4">
      <h2 className="px-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        Monthly profit &amp; loss
      </h2>
      <p className="px-2 pb-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Gross profit (lab + consult) vs total expenses, with operational net income.
      </p>
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval="preserveStartEnd"
              angle={-30}
              textAnchor="end"
              height={50}
            />
            <YAxis tickFormatter={compactPeso} tick={{ fontSize: 11 }} width={56} />
            <Tooltip formatter={(v: number) => PESO(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="grossProfit" name="Gross profit" fill="var(--color-brand-navy)" radius={[2, 2, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#c0504d" radius={[2, 2, 0, 0]} />
            <Line dataKey="net" name="Net income" type="monotone" stroke="#e9a23b" strokeWidth={2} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Replace the Trends page stub** (`trends/page.tsx`) with:

```tsx
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Card } from "@/components/ui/card";
import { buildMonthlyPnl } from "@/lib/operations/trends";
import { OperationsTabs } from "../_components/operations-tabs";
import { PnlTrendChart } from "./_components/pnl-trend-chart";

export default async function OperationsTrendsPage() {
  await requireAdminStaff();

  const admin = createAdminClient();
  const [totalsRes, expenseRes] = await Promise.all([
    admin.from("v_ops_daily_totals").select("business_date, net"),
    admin.from("v_ops_daily_expenses").select("business_date, expense_php"),
  ]);

  if (totalsRes.error || expenseRes.error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the trends data. Please try again.
        </Card>
      </div>
    );
  }

  const data = buildMonthlyPnl(totalsRes.data ?? [], expenseRes.data ?? []);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
      <OperationsTabs />
      <PnlTrendChart data={data} />
    </div>
  );
}
```

> Note: `totalsRes.data` is typed `{ business_date: string | null; net: number | null }[]` and `expenseRes.data` `{ business_date: string | null; expense_php: number | null }[]` from `database.ts` — both assignable to `buildMonthlyPnl`'s params (which accept `number | string | null`). If the typecheck complains, cast with `as` minimally rather than widening the helper.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/operations/trends/"
git commit -m "feat(ops): Trends tab — monthly P&L chart (recharts)"
```

---

### Task 5: Final verification + PR update (orchestrator)

- [ ] **Step 1: Typecheck + lint + full tests**

```bash
npm run typecheck && npm run lint && npx vitest run
```
Expected: typecheck clean; lint clean except the pre-existing `scripts/clinical-backfill/engine.ts:81` prefer-const + 2 unused-import warnings (untouched); vitest all green (167 prior + 4 new = ~171).

- [ ] **Step 2: Dev-server route compile check** (orchestrator)

Start `npm run dev`; GET `/staff/admin/operations/trends` and `/staff` — confirm a 307 redirect to login (auth gate) with no 500/compile error in the server log. (recharts renders client-side; the full authenticated visual/mobile smoke — including the card↔tab reconciliation — is the user's combined smoke on PR #50.)

- [ ] **Step 3: Update the PR #50 body** to note the two additions (Net income card + Trends chart + recharts dep) and add a smoke checklist item: *card MTD net income == Expenses & P&L tab MTD net income; chart renders + reflows on mobile*. No code commit.

---

## Self-review notes (for the orchestrator)

- **Spec coverage:** card registry + data + render (Task 1), `buildMonthlyPnl` pure core (Task 2), recharts dep (Task 3), Trends page + chart (Task 4), verification + PR (Task 5). All spec sections covered.
- **Reuse / consistency:** card and chart use the SAME definition as the B1.3 tab — `Σ v_ops_daily_totals.net` (gross profit) − `Σ v_ops_daily_expenses.expense_php` (expenses). Verified on prod the totals view has only `lab`+`consult` sections, so no section filter is needed. `num` reused from `daily-report.ts`.
- **No schema change, no new views, admin-only, read-only.** New dep limited to `recharts`.
- **Type consistency:** `MonthlyPnlRow` (Task 2) is the single prop type consumed by `PnlTrendChart` (Task 4). `netIncomeMtd` (Task 1) flows loader → `stats` → `StatCard`. `admin.net_income_mtd` id is identical in `cards.ts` and every `show(...)` call.
- **Carry-forwards honored:** navy theme, mobile-first (ResponsiveContainer + abbreviated ticks), en-PH PHP, short error-card pattern, `SKIP_DATA` gating idiom matched.
