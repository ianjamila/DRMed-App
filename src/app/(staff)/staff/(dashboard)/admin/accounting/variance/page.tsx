import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { VarianceRow } from "./variance-row";

export const metadata = { title: "Budget vs actual — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface SearchProps {
  searchParams: Promise<{ year?: string }>;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
}

interface BudgetRow {
  account_id: string;
  annual_amount_php: number;
  notes: string | null;
}

interface LineRow {
  debit_php: number;
  credit_php: number;
  journal_entries: { posting_date: string; status: string } | null;
  chart_of_accounts: { id: string; normal_balance: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  revenue: "Revenue",
  contra_revenue: "Contra revenue",
  expense: "Expenses",
};

const TYPES_IN_ORDER = ["revenue", "contra_revenue", "expense"] as const;

function balanceFor(d: number, c: number, normal: string): number {
  return normal === "credit" ? c - d : d - c;
}

export default async function VariancePage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const currentYear = Number(todayISO.slice(0, 4));
  const requestedYear = Number(sp.year);
  const year =
    Number.isFinite(requestedYear) && requestedYear >= 2020 && requestedYear <= currentYear + 1
      ? requestedYear
      : currentYear;

  // YTD-budget pro-ration. For the current year we use elapsed months;
  // for prior years we use 12 (full year); for future years we use 0.
  const monthsElapsed =
    year < currentYear
      ? 12
      : year > currentYear
        ? 0
        : Number(todayISO.slice(5, 7));
  const proration = monthsElapsed / 12;

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const admin = createAdminClient();

  const [{ data: accounts }, { data: budgets }, { data: lines }] = await Promise.all([
    admin
      .from("chart_of_accounts")
      .select("id, code, name, type, normal_balance")
      .eq("is_active", true)
      .in("type", ["revenue", "contra_revenue", "expense"])
      .order("code"),
    admin
      .from("budgets")
      .select("account_id, annual_amount_php, notes")
      .eq("fiscal_year", year),
    admin
      .from("journal_lines")
      .select(
        `
        debit_php, credit_php,
        journal_entries!inner ( posting_date, status ),
        chart_of_accounts!inner ( id, normal_balance )
      `,
      )
      .eq("journal_entries.status", "posted")
      .gte("journal_entries.posting_date", yearStart)
      .lte("journal_entries.posting_date", yearEnd)
      .in("chart_of_accounts.type", ["revenue", "contra_revenue", "expense"])
      .returns<LineRow[]>(),
  ]);

  const acctRows = (accounts ?? []) as AccountRow[];
  const budgetMap = new Map<string, BudgetRow>();
  for (const b of (budgets ?? []) as BudgetRow[]) budgetMap.set(b.account_id, b);

  const actualMap = new Map<string, number>();
  for (const l of lines ?? []) {
    const acct = l.chart_of_accounts;
    if (!acct) continue;
    const signed = balanceFor(
      Number(l.debit_php ?? 0),
      Number(l.credit_php ?? 0),
      acct.normal_balance,
    );
    actualMap.set(acct.id, (actualMap.get(acct.id) ?? 0) + signed);
  }

  // Group accounts by type, sort by code within.
  const byType: Record<string, AccountRow[]> = {
    revenue: [],
    contra_revenue: [],
    expense: [],
  };
  for (const a of acctRows) byType[a.type]?.push(a);
  for (const t of Object.keys(byType)) {
    byType[t].sort((a, b) => a.code.localeCompare(b.code));
  }

  // Totals
  let totalBudget = 0;
  let totalActual = 0;
  let totalYtdBudget = 0;
  for (const a of acctRows) {
    const budget = Number(budgetMap.get(a.id)?.annual_amount_php ?? 0);
    const actual = Number(actualMap.get(a.id) ?? 0);
    totalBudget += budget;
    totalActual += actual;
    totalYtdBudget += budget * proration;
  }

  const years: number[] = [];
  for (let y = currentYear + 1; y >= 2023; y--) years.push(y);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Budget vs actual
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Annual budget per account compared to YTD actual posted JEs.
            YTD budget pro-rates the annual figure by elapsed months
            ({monthsElapsed}/12 = {(proration * 100).toFixed(0)}%).
          </p>
        </div>
        <form action="" className="flex items-center gap-2">
          <label
            htmlFor="year"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Year
          </label>
          <select
            id="year"
            name="year"
            defaultValue={String(year)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Go
          </button>
        </form>
      </header>

      <div className="my-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Annual budget"
          value={PHP.format(totalBudget)}
          hint={`${budgetMap.size} account${budgetMap.size === 1 ? "" : "s"} with a budget`}
        />
        <SummaryTile
          label="YTD budget (pro-rated)"
          value={PHP.format(totalYtdBudget)}
          hint={`${monthsElapsed}/12 of annual`}
        />
        <SummaryTile
          label="YTD actual"
          value={PHP.format(totalActual)}
          hint="Posted JEs only"
        />
        <SummaryTile
          label="YTD variance"
          value={PHP.format(totalActual - totalYtdBudget)}
          hint={
            totalYtdBudget > 0
              ? `${(((totalActual - totalYtdBudget) / totalYtdBudget) * 100).toFixed(1)}% of budget`
              : "—"
          }
          tone={Math.abs(totalActual - totalYtdBudget) > 1000 ? "warn" : "ok"}
        />
      </div>

      <div className="space-y-6">
        {TYPES_IN_ORDER.map((type) => {
          const accts = byType[type];
          if (accts.length === 0) return null;
          return (
            <section
              key={type}
              className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white"
            >
              <h2 className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                {TYPE_LABEL[type]}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-[color:var(--color-brand-bg)]/50 text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    <tr>
                      <th className="px-4 py-2">Account</th>
                      <th className="px-4 py-2 text-right">Annual budget</th>
                      <th className="px-4 py-2 text-right">YTD budget</th>
                      <th className="px-4 py-2 text-right">YTD actual</th>
                      <th className="px-4 py-2 text-right">Variance</th>
                      <th className="px-4 py-2 text-right">%</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                    {accts.map((a) => (
                      <VarianceRow
                        key={a.id}
                        fiscalYear={year}
                        accountId={a.id}
                        code={a.code}
                        name={a.name}
                        accountType={type}
                        annualBudget={Number(
                          budgetMap.get(a.id)?.annual_amount_php ?? 0,
                        )}
                        actualYtd={Number(actualMap.get(a.id) ?? 0)}
                        proration={proration}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-[color:var(--color-brand-text-soft)]">
        Variance = actual − YTD budget. For revenue, positive variance means
        beating plan (good). For expense and contra-revenue, positive variance
        means over-spending (bad). The % column shows variance ÷ YTD budget.
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  const accent =
    tone === "warn"
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
