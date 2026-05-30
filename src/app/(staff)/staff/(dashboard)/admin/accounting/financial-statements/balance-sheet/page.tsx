import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { paginatedFetch } from "@/lib/supabase/paginated-fetch";
import { todayManilaISODate } from "@/lib/dates/manila";
import { StatementTabs } from "../_components/statement-tabs";

export const metadata = { title: "Balance sheet — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface SearchProps {
  searchParams: Promise<{ as_of?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface LineRow {
  debit_php: number;
  credit_php: number;
  journal_entries: { posting_date: string; status: string } | null;
  chart_of_accounts:
    | { id: string; code: string; name: string; type: string; normal_balance: string }
    | null;
}

interface AccountBalance {
  id: string;
  code: string;
  name: string;
  type: string;
  amount: number;
}

const SECTION_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
};

function balanceFor(
  row: { debit_php: number; credit_php: number },
  normal_balance: string,
): number {
  const d = Number(row.debit_php ?? 0);
  const c = Number(row.credit_php ?? 0);
  return normal_balance === "credit" ? c - d : d - c;
}

export default async function BalanceSheetPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const asOf = sp.as_of && DATE_RE.test(sp.as_of) ? sp.as_of : todayISO;

  const admin = createAdminClient();

  // ---- 1) Account balances for asset / liability / equity through asOf ----
  const balanceLines = await paginatedFetch<LineRow>((from, to) =>
    admin
      .from("journal_lines")
      .select(
        `
        debit_php, credit_php,
        journal_entries!inner ( posting_date, status ),
        chart_of_accounts!inner ( id, code, name, type, normal_balance )
      `,
      )
      .eq("journal_entries.status", "posted")
      .lte("journal_entries.posting_date", asOf)
      .in("chart_of_accounts.type", ["asset", "liability", "equity"])
      .range(from, to)
      .returns<LineRow[]>(),
  );

  const balances = new Map<string, AccountBalance>();

  for (const row of balanceLines) {
    const acct = row.chart_of_accounts;
    if (!acct) continue;
    const delta = balanceFor(row, acct.normal_balance);
    const existing = balances.get(acct.id);
    if (existing) existing.amount += delta;
    else
      balances.set(acct.id, {
        id: acct.id,
        code: acct.code,
        name: acct.name,
        type: acct.type,
        amount: delta,
      });
  }

  // ---- 2) Retained earnings to-date = net income from inception → asOf ----
  // The income statement isn't closed-out on a recurring basis (no period-
  // close JEs that flip P&L to RE), so revenue/expense are still open. We
  // compute the implied closing balance here as "computed retained earnings".
  interface PnlRow {
    debit_php: number;
    credit_php: number;
    chart_of_accounts: { normal_balance: string; type: string } | null;
  }
  const pnlLines = await paginatedFetch<PnlRow>((from, to) =>
    admin
      .from("journal_lines")
      .select(
        `
        debit_php, credit_php,
        journal_entries!inner ( posting_date, status ),
        chart_of_accounts!inner ( normal_balance, type )
      `,
      )
      .eq("journal_entries.status", "posted")
      .lte("journal_entries.posting_date", asOf)
      .in("chart_of_accounts.type", ["revenue", "contra_revenue", "expense"])
      .range(from, to)
      .returns<PnlRow[]>(),
  );

  let netIncomeToDate = 0;
  for (const row of pnlLines) {
    const acct = row.chart_of_accounts;
    if (!acct) continue;
    const signed = balanceFor(row, acct.normal_balance);
    if (acct.type === "revenue") netIncomeToDate += signed;
    else if (acct.type === "contra_revenue") netIncomeToDate -= signed;
    else if (acct.type === "expense") netIncomeToDate -= signed;
  }

  // Group balances by type, sort by code.
  const byType: Record<string, AccountBalance[]> = {
    asset: [],
    liability: [],
    equity: [],
  };
  for (const b of balances.values()) byType[b.type]?.push(b);
  for (const t of Object.keys(byType))
    byType[t].sort((a, b) => a.code.localeCompare(b.code));

  const totalAssets = byType.asset.reduce((s, a) => s + a.amount, 0);
  const totalLiabilities = byType.liability.reduce((s, a) => s + a.amount, 0);
  const totalEquity = byType.equity.reduce((s, a) => s + a.amount, 0);
  const totalLiabAndEquity = totalLiabilities + totalEquity + netIncomeToDate;
  const balanced = Math.abs(totalAssets - totalLiabAndEquity) < 0.01;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Financial statements
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Balance sheet as of <strong>{asOf}</strong>. Cumulative posted
          journal entries through this date.
        </p>
      </header>

      <StatementTabs />

      <BalanceSheetAsOfPresets asOf={asOf} todayISO={todayISO} />

      <form
        action=""
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label
            htmlFor="as_of"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            As of date
          </label>
          <input
            type="date"
            id="as_of"
            name="as_of"
            defaultValue={asOf}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Recalculate
        </button>
      </form>

      {!balanced ? (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Out of balance:</strong> Assets ({PHP.format(totalAssets)}) ≠
          Liabilities + Equity ({PHP.format(totalLiabAndEquity)}). Difference:{" "}
          {PHP.format(totalAssets - totalLiabAndEquity)}. Likely a missing
          opening-balance JE or an unposted entry — investigate before relying
          on these numbers.
        </div>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {/* ASSETS */}
            <SectionRow title={SECTION_LABEL.asset} />
            {byType.asset.length === 0 ? (
              <EmptyRow message="No asset balances." />
            ) : (
              byType.asset.map((a) => <AccountRow key={a.id} account={a} />)
            )}
            <TotalRow label="Total assets" amount={totalAssets} />

            {/* LIABILITIES */}
            <SectionRow title={SECTION_LABEL.liability} />
            {byType.liability.length === 0 ? (
              <EmptyRow message="No liability balances." />
            ) : (
              byType.liability.map((a) => <AccountRow key={a.id} account={a} />)
            )}
            <TotalRow label="Total liabilities" amount={totalLiabilities} />

            {/* EQUITY */}
            <SectionRow title={SECTION_LABEL.equity} />
            {byType.equity.length === 0 ? (
              <EmptyRow message="No equity balances." />
            ) : (
              byType.equity.map((a) => <AccountRow key={a.id} account={a} />)
            )}
            <tr>
              <td className="px-4 py-2 pl-8 text-[color:var(--color-brand-text)]">
                <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  —
                </span>{" "}
                Net income to date{" "}
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  (computed)
                </span>
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {PHP.format(netIncomeToDate)}
              </td>
            </tr>
            <TotalRow
              label="Total equity"
              amount={totalEquity + netIncomeToDate}
            />

            {/* LIAB + EQUITY */}
            <TotalRow
              label="Total liabilities + equity"
              amount={totalLiabAndEquity}
              emphasize
            />
          </tbody>
        </table>
      </section>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          How this is computed
        </summary>
        <div className="mt-3 space-y-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <p>
            Each account&apos;s balance is the cumulative signed sum of its
            posted journal lines with <code>posting_date ≤ as_of</code>:{" "}
            <code>credit − debit</code> for credit-normal accounts,{" "}
            <code>debit − credit</code> for debit-normal accounts.
          </p>
          <p>
            <strong>Net income to date</strong> is computed inline because the
            books aren&apos;t closed-out into Retained Earnings on a recurring
            basis — there are no period-close JEs that flip revenue/expense
            balances into <code>3200 Retained Earnings</code>. So we compute
            the implied closing balance and present it as a separate line
            inside equity, which keeps the balance sheet balanced.
          </p>
          <p>
            The amber &quot;out of balance&quot; banner appears when total
            assets diverge from total liabilities + equity (including net
            income) by more than ₱0.01 — typically a missing opening-balance
            JE or an unposted entry.
          </p>
        </div>
      </details>
    </div>
  );
}

function SectionRow({ title }: { title: string }) {
  return (
    <tr className="bg-[color:var(--color-brand-bg)]">
      <td
        colSpan={2}
        className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        {title}
      </td>
    </tr>
  );
}

function AccountRow({ account }: { account: AccountBalance }) {
  return (
    <tr className="hover:bg-[color:var(--color-brand-bg)]/50">
      <td className="px-4 py-2 pl-8">
        <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {account.code}
        </span>{" "}
        <span className="text-[color:var(--color-brand-text)]">{account.name}</span>
      </td>
      <td className="px-4 py-2 text-right font-mono">
        {PHP.format(account.amount)}
      </td>
    </tr>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <tr>
      <td
        colSpan={2}
        className="px-4 py-3 pl-8 text-xs italic text-[color:var(--color-brand-text-soft)]"
      >
        {message}
      </td>
    </tr>
  );
}

function TotalRow({
  label,
  amount,
  emphasize = false,
}: {
  label: string;
  amount: number;
  emphasize?: boolean;
}) {
  return (
    <tr
      className={
        emphasize
          ? "border-t-2 border-[color:var(--color-brand-navy)]/30 bg-[color:var(--color-brand-bg)]/60 font-bold"
          : "font-semibold"
      }
    >
      <td className="px-4 py-3 text-[color:var(--color-brand-navy)]">{label}</td>
      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-navy)]">
        {PHP.format(amount)}
      </td>
    </tr>
  );
}

function BalanceSheetAsOfPresets({ asOf, todayISO }: { asOf: string; todayISO: string }) {
  const today = new Date(`${todayISO}T00:00:00+08:00`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const endOfPrevMonth = new Date(Date.UTC(y, m, 0));
  const endOfPrevQuarter = (() => {
    const qStartMonth = Math.floor(m / 3) * 3; // 0, 3, 6, 9
    return new Date(Date.UTC(y, qStartMonth, 0));
  })();
  const endOfLastYear = new Date(Date.UTC(y - 1, 11, 31));
  const endOfTwoYearsAgo = new Date(Date.UTC(y - 2, 11, 31));

  const presets = [
    { key: "today", label: "Today", date: todayISO },
    { key: "prev-month", label: "End of last month", date: iso(endOfPrevMonth) },
    { key: "prev-q", label: "End of last quarter", date: iso(endOfPrevQuarter) },
    { key: "prev-year", label: `End of ${y - 1}`, date: iso(endOfLastYear) },
    { key: "two-years", label: `End of ${y - 2}`, date: iso(endOfTwoYearsAgo) },
  ];

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Quick dates
      </span>
      {presets.map((p) => {
        const active = p.date === asOf;
        return (
          <Link
            key={p.key}
            href={`/staff/admin/accounting/financial-statements/balance-sheet?as_of=${p.date}`}
            className={
              "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider " +
              (active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]")
            }
          >
            {p.label}
          </Link>
        );
      })}
      <span className="text-[10px] text-[color:var(--color-brand-text-soft)]">or pick custom below</span>
    </div>
  );
}
