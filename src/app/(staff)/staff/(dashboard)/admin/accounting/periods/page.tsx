import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISO } from "@/lib/marketing/closures";
import { PeriodActionsClient } from "./period-actions-client";

export const metadata = { title: "Accounting periods — staff" };
export const dynamic = "force-dynamic";

const MONTH_LABEL = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const QUARTER_MONTHS: Record<1 | 2 | 3 | 4, string> = {
  1: "Jan – Mar",
  2: "Apr – Jun",
  3: "Jul – Sep",
  4: "Oct – Dec",
};

export default async function PeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const todayISO = todayManilaISO();
  const year = Number(sp.year) || Number(todayISO.slice(0, 4));

  const admin = createAdminClient();

  const { data: periods } = await admin
    .from("accounting_periods")
    .select("id, fiscal_year, fiscal_quarter, fiscal_month, status, period_start, period_end, closed_at, notes")
    .eq("fiscal_year", year)
    .order("fiscal_month", { ascending: true });

  // JE counts per period (posted only) — single query.
  const { data: jeCounts } = await admin
    .from("journal_entries")
    .select("posting_date", { count: "exact", head: false })
    .gte("posting_date", `${year}-01-01`)
    .lte("posting_date", `${year}-12-31`)
    .eq("status", "posted");

  const countsByMonth = new Map<number, number>();
  for (const e of jeCounts ?? []) {
    if (!e.posting_date) continue;
    const m = new Date(e.posting_date).getUTCMonth() + 1;
    countsByMonth.set(m, (countsByMonth.get(m) ?? 0) + 1);
  }

  type PeriodRow = NonNullable<typeof periods>[number];
  const byQuarter: Record<1 | 2 | 3 | 4, PeriodRow[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of periods ?? []) {
    byQuarter[p.fiscal_quarter as 1 | 2 | 3 | 4].push(p);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.1 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Accounting periods
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            Periods are monthly in the schema; closes operate on a fiscal quarter
            (atomically locks all three months). Reopening a closed quarter requires
            a reason note.
          </p>
        </div>
        <form className="flex items-center gap-2">
          <label htmlFor="year-picker" className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Year
          </label>
          <select
            id="year-picker"
            name="year"
            defaultValue={year}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
          >
            {Array.from({ length: 9 }, (_, i) => 2020 + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white"
          >
            Go
          </button>
        </form>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3, 4].map((q) => {
          const months = byQuarter[q as 1 | 2 | 3 | 4];
          const allClosed = months.length > 0 && months.every((m) => m.status === "closed");
          const allOpen = months.length > 0 && months.every((m) => m.status === "open");
          const lastQuarterDayISO = (() => {
            const d = new Date(Date.UTC(year, q * 3, 0));
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
          })();
          const inFuture = todayISO <= lastQuarterDayISO;
          return (
            <section
              key={q}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
            >
              <div className="mb-3 flex items-start justify-between">
                <div>
                  <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                    Q{q} {year}
                  </h2>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {QUARTER_MONTHS[q as 1 | 2 | 3 | 4]}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                    allClosed
                      ? "bg-slate-200 text-slate-700"
                      : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {allClosed ? "Closed" : "Open"}
                </span>
              </div>
              <ul className="space-y-1 text-sm">
                {months.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between rounded-md bg-[color:var(--color-brand-bg)] px-2 py-1"
                  >
                    <span className="font-mono text-xs">
                      {MONTH_LABEL[m.fiscal_month - 1]} · {countsByMonth.get(m.fiscal_month) ?? 0} JEs
                    </span>
                    <span
                      className={`text-xs ${
                        m.status === "closed"
                          ? "text-slate-500"
                          : "text-emerald-700"
                      }`}
                    >
                      {m.status}
                    </span>
                  </li>
                ))}
              </ul>
              <PeriodActionsClient
                year={year}
                quarter={q as 1 | 2 | 3 | 4}
                state={allClosed ? "closed" : allOpen ? "open" : "mixed"}
                inFuture={inFuture}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
