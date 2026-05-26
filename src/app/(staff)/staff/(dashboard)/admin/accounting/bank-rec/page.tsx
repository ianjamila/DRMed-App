import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Bank reconciliation — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface StatementRow {
  id: string;
  account_id: string;
  period_start: string;
  period_end: string;
  statement_label: string;
  uploaded_at: string;
  chart_of_accounts: { code: string; name: string } | null;
  bank_statement_lines:
    | { id: string; matched_je_line_id: string | null; amount_php: number }[]
    | null;
}

export default async function BankRecPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data } = await admin
    .from("bank_statements")
    .select(
      `
      id, account_id, period_start, period_end, statement_label, uploaded_at,
      chart_of_accounts ( code, name ),
      bank_statement_lines ( id, matched_je_line_id, amount_php )
    `,
    )
    .order("period_start", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .returns<StatementRow[]>();

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Bank reconciliation
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Upload a bank statement (CSV), and the system auto-matches each
            transaction to a posted journal-line on the same cash account.
            Unmatched lines surface for manual review.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/bank-rec/upload"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          + Upload statement
        </Link>
      </header>

      <section className="mt-6 overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No statements uploaded yet. Click <strong>+ Upload statement</strong> to get started.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Statement</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3 text-right">Lines</th>
                <th className="px-4 py-3 text-right">Net amount</th>
                <th className="px-4 py-3">Match progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {rows.map((s) => {
                const lines = s.bank_statement_lines ?? [];
                const matched = lines.filter((l) => l.matched_je_line_id).length;
                const total = lines.length;
                const matchPct = total === 0 ? 0 : Math.round((matched / total) * 100);
                const net = lines.reduce((sum, l) => sum + Number(l.amount_php ?? 0), 0);
                const acct = Array.isArray(s.chart_of_accounts)
                  ? s.chart_of_accounts[0]
                  : s.chart_of_accounts;
                return (
                  <tr
                    key={s.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/admin/accounting/bank-rec/${s.id}`}
                        className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {s.statement_label}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {acct ? (
                        <>
                          <span className="font-mono text-xs">{acct.code}</span>{" "}
                          {acct.name}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {s.period_start} → {s.period_end}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{total}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(net)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-[color:var(--color-brand-bg-mid)]">
                          <div
                            className={`h-full ${matchPct === 100 ? "bg-emerald-500" : matchPct >= 80 ? "bg-amber-400" : "bg-red-400"}`}
                            style={{ width: `${matchPct}%` }}
                          />
                        </div>
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {matched}/{total} ({matchPct}%)
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
