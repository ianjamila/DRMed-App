import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Financial statements — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
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
  normal_balance: string;
  amount: number; // signed, positive in the natural P&L direction
}

const TYPE_LABELS: Record<string, string> = {
  revenue: "Revenue",
  contra_revenue: "Less: contra revenue",
  expense: "Operating expenses",
};

const TYPES_IN_ORDER = ["revenue", "contra_revenue", "expense"] as const;

function plnaturalSign(type: string): 1 | -1 {
  // For P&L presentation: revenue is shown as positive (credit balance),
  // contra revenue is shown as a positive number that's subtracted from
  // revenue, expense is shown as positive (debit balance).
  switch (type) {
    case "revenue":
      return 1;
    case "contra_revenue":
      return 1;
    case "expense":
      return 1;
    default:
      return 1;
  }
}

function balanceFor(
  row: { debit_php: number; credit_php: number },
  normal_balance: string,
): number {
  const d = Number(row.debit_php ?? 0);
  const c = Number(row.credit_php ?? 0);
  return normal_balance === "credit" ? c - d : d - c;
}

export default async function FinancialStatementsPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const yearStart = `${todayISO.slice(0, 4)}-01-01`;

  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : yearStart;
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : todayISO;

  const admin = createAdminClient();

  const { data: lines } = await admin
    .from("journal_lines")
    .select(
      `
      debit_php, credit_php,
      journal_entries!inner ( posting_date, status ),
      chart_of_accounts!inner ( id, code, name, type, normal_balance )
    `,
    )
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.posting_date", start)
    .lte("journal_entries.posting_date", end)
    .in("chart_of_accounts.type", [
      "revenue",
      "contra_revenue",
      "expense",
    ])
    .returns<LineRow[]>();

  const balances = new Map<string, AccountBalance>();

  for (const row of lines ?? []) {
    const acct = row.chart_of_accounts;
    if (!acct) continue;
    const sign = plnaturalSign(acct.type);
    const delta = sign * balanceFor(row, acct.normal_balance);
    const existing = balances.get(acct.id);
    if (existing) {
      existing.amount += delta;
    } else {
      balances.set(acct.id, {
        id: acct.id,
        code: acct.code,
        name: acct.name,
        type: acct.type,
        normal_balance: acct.normal_balance,
        amount: delta,
      });
    }
  }

  // Group by type, sort by code within type.
  const byType: Record<string, AccountBalance[]> = {
    revenue: [],
    contra_revenue: [],
    expense: [],
  };
  for (const b of balances.values()) {
    byType[b.type]?.push(b);
  }
  for (const t of Object.keys(byType)) {
    byType[t].sort((a, b) => a.code.localeCompare(b.code));
  }

  const subtotal = (type: string) =>
    byType[type].reduce((s, a) => s + a.amount, 0);

  const totalRevenue = subtotal("revenue");
  const totalContraRevenue = subtotal("contra_revenue");
  const netRevenue = totalRevenue - totalContraRevenue;
  const totalExpense = subtotal("expense");
  const netIncome = netRevenue - totalExpense;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Income statement
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Computed from posted journal entries with{" "}
          <code>posting_date</code> in <strong>{start}</strong> →{" "}
          <strong>{end}</strong>. Balance sheet and cash flow are still
          on the roadmap.
        </p>
      </header>

      <form
        action=""
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Start date
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            End date
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
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

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {balances.size === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No posted journal entries in this range.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {TYPES_IN_ORDER.map((type) => {
                const accts = byType[type];
                if (accts.length === 0) return null;
                const sectionTotal = subtotal(type);
                return (
                  <SectionGroup
                    key={type}
                    title={TYPE_LABELS[type]}
                    accounts={accts}
                    sectionTotal={sectionTotal}
                  />
                );
              })}
              <PnLLine label="Net revenue" amount={netRevenue} emphasize />
              <PnLLine
                label="Net income"
                amount={netIncome}
                emphasize
                positiveIsGood
              />
            </tbody>
          </table>
        )}
      </section>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          How this is computed
        </summary>
        <div className="mt-3 space-y-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <p>
            For each posted journal line in the date range, the line&apos;s
            signed contribution to its account is computed as{" "}
            <code>
              credit − debit
            </code>{" "}
            for credit-normal accounts (revenue, contra revenue) and{" "}
            <code>debit − credit</code> for debit-normal accounts (expense).
            Lines are grouped by account, then by account type. Net revenue
            = revenue − contra revenue. Net income = net revenue − operating
            expenses.
          </p>
          <p>
            This statement includes only accounts of type{" "}
            <code>revenue</code>, <code>contra_revenue</code>, and{" "}
            <code>expense</code>. Asset, liability, equity, and memo accounts
            will appear on the balance sheet (separate report, not yet built).
          </p>
        </div>
      </details>
    </div>
  );
}

function SectionGroup({
  title,
  accounts,
  sectionTotal,
}: {
  title: string;
  accounts: AccountBalance[];
  sectionTotal: number;
}) {
  return (
    <>
      <tr className="bg-[color:var(--color-brand-bg)]">
        <td
          colSpan={2}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
        >
          {title}
        </td>
      </tr>
      {accounts.map((a) => (
        <tr key={a.id} className="hover:bg-[color:var(--color-brand-bg)]/50">
          <td className="px-4 py-2 pl-8">
            <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
              {a.code}
            </span>{" "}
            <span className="text-[color:var(--color-brand-text)]">{a.name}</span>
          </td>
          <td className="px-4 py-2 text-right font-mono">
            {PHP.format(a.amount)}
          </td>
        </tr>
      ))}
      <tr className="font-semibold">
        <td className="px-4 py-2 pl-8 text-[color:var(--color-brand-navy)]">
          Total {title.replace(/^Less: /, "").toLowerCase()}
        </td>
        <td className="px-4 py-2 text-right font-mono text-[color:var(--color-brand-navy)]">
          {PHP.format(sectionTotal)}
        </td>
      </tr>
    </>
  );
}

function PnLLine({
  label,
  amount,
  emphasize = false,
  positiveIsGood = false,
}: {
  label: string;
  amount: number;
  emphasize?: boolean;
  positiveIsGood?: boolean;
}) {
  const color = positiveIsGood
    ? amount >= 0
      ? "text-emerald-700"
      : "text-red-700"
    : "text-[color:var(--color-brand-navy)]";
  return (
    <tr
      className={
        emphasize
          ? "border-t-2 border-[color:var(--color-brand-navy)]/30 bg-[color:var(--color-brand-bg)]/60 font-bold"
          : "font-semibold"
      }
    >
      <td className="px-4 py-3 text-[color:var(--color-brand-navy)]">{label}</td>
      <td className={`px-4 py-3 text-right font-mono ${color}`}>
        {PHP.format(amount)}
      </td>
    </tr>
  );
}
