import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { RerunMatchButton } from "./rerun-match-button";
import { ManualMatchClient } from "./manual-match-client";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Bank statement — staff" };
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
  notes: string | null;
  uploaded_at: string;
  chart_of_accounts: { code: string; name: string } | null;
}

interface LineRow {
  id: string;
  transaction_date: string;
  description: string | null;
  reference: string | null;
  amount_php: number;
  matched_je_line_id: string | null;
  match_method: string | null;
  matched_at: string | null;
  journal_lines:
    | {
        id: string;
        debit_php: number;
        credit_php: number;
        description: string | null;
        journal_entries: {
          id: string;
          entry_number: string;
          posting_date: string;
          description: string;
          source_kind: string;
        } | null;
      }
    | null;
}

interface CandidateRow {
  id: string;
  debit_php: number;
  credit_php: number;
  journal_entries: {
    id: string;
    entry_number: string;
    posting_date: string;
    description: string;
  } | null;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function BankStatementDetailPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: statement }, { data: lines }] = await Promise.all([
    admin
      .from("bank_statements")
      .select(
        "id, account_id, period_start, period_end, statement_label, notes, uploaded_at, chart_of_accounts ( code, name )",
      )
      .eq("id", id)
      .maybeSingle<StatementRow>(),
    admin
      .from("bank_statement_lines")
      .select(
        `
        id, transaction_date, description, reference, amount_php,
        matched_je_line_id, match_method, matched_at,
        journal_lines (
          id, debit_php, credit_php, description,
          journal_entries ( id, entry_number, posting_date, description, source_kind )
        )
      `,
      )
      .eq("statement_id", id)
      .order("transaction_date", { ascending: true })
      .returns<LineRow[]>(),
  ]);

  if (!statement) notFound();

  const allLines = lines ?? [];
  const matched = allLines.filter((l) => l.matched_je_line_id);
  const unmatched = allLines.filter((l) => !l.matched_je_line_id);
  const matchPct =
    allLines.length === 0
      ? 0
      : Math.round((matched.length / allLines.length) * 100);

  // Build candidate map for unmatched lines: JE lines on the same account,
  // unmatched in ANY bank statement, posting_date within ±7 days of each
  // bank line's transaction_date.
  const candidates: Map<string, CandidateRow[]> = new Map();
  if (unmatched.length > 0) {
    const minD = unmatched.reduce(
      (m, l) => (l.transaction_date < m ? l.transaction_date : m),
      unmatched[0].transaction_date,
    );
    const maxD = unmatched.reduce(
      (m, l) => (l.transaction_date > m ? l.transaction_date : m),
      unmatched[0].transaction_date,
    );
    const start = shiftDate(minD, -7);
    const end = shiftDate(maxD, 7);

    const { data: alreadyMatched } = await admin
      .from("bank_statement_lines")
      .select("matched_je_line_id")
      .not("matched_je_line_id", "is", null);
    const claimedSet = new Set(
      (alreadyMatched ?? [])
        .map((m) => m.matched_je_line_id)
        .filter((x): x is string => !!x),
    );

    const { data: candLines } = await admin
      .from("journal_lines")
      .select(
        `
        id, debit_php, credit_php,
        journal_entries!inner ( id, entry_number, posting_date, description, status )
      `,
      )
      .eq("account_id", statement.account_id)
      .eq("journal_entries.status", "posted")
      .gte("journal_entries.posting_date", start)
      .lte("journal_entries.posting_date", end);

    const usable = (candLines ?? []).filter(
      (c) => !claimedSet.has((c as { id: string }).id),
    );

    for (const bl of unmatched) {
      const matches = usable
        .map((c) => {
          const c2 = c as unknown as {
            id: string;
            debit_php: number;
            credit_php: number;
            journal_entries: {
              id: string;
              entry_number: string;
              posting_date: string;
              description: string;
            };
          };
          return {
            row: c2,
            delta: Math.abs(
              Date.parse(c2.journal_entries.posting_date) -
                Date.parse(bl.transaction_date),
            ),
            signed: Number(c2.debit_php) - Number(c2.credit_php),
          };
        })
        .sort((a, b) => {
          const aExact = a.signed === Number(bl.amount_php) ? 0 : 1;
          const bExact = b.signed === Number(bl.amount_php) ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return a.delta - b.delta;
        })
        .slice(0, 10)
        .map(
          (x): CandidateRow => ({
            id: x.row.id,
            debit_php: x.row.debit_php,
            credit_php: x.row.credit_php,
            journal_entries: x.row.journal_entries,
          }),
        );
      candidates.set(bl.id, matches);
    }
  }

  const acct = Array.isArray(statement.chart_of_accounts)
    ? statement.chart_of_accounts[0]
    : statement.chart_of_accounts;

  const netInflow = allLines.reduce(
    (s, l) => s + (Number(l.amount_php) > 0 ? Number(l.amount_php) : 0),
    0,
  );
  const netOutflow = allLines.reduce(
    (s, l) => s + (Number(l.amount_php) < 0 ? Math.abs(Number(l.amount_php)) : 0),
    0,
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/accounting/bank-rec"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Bank reconciliation
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {statement.statement_label}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {acct ? (
              <>
                Account{" "}
                <span className="font-mono text-xs">{acct.code}</span>{" "}
                {acct.name} ·{" "}
              </>
            ) : null}
            {statement.period_start} → {statement.period_end}
          </p>
        </div>
        <RerunMatchButton statementId={statement.id} />
      </header>

      <div className="my-6 grid gap-4 sm:grid-cols-4">
        <SummaryTile
          label="Total lines"
          value={String(allLines.length)}
          hint={`${matched.length} matched (${matchPct}%)`}
        />
        <SummaryTile
          label="Inflows"
          value={PHP.format(netInflow)}
          hint=" "
          tone="ok"
        />
        <SummaryTile
          label="Outflows"
          value={PHP.format(netOutflow)}
          hint=" "
          tone={netOutflow > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Unmatched"
          value={String(unmatched.length)}
          hint={unmatched.length > 0 ? "Manual review needed" : "All clear ✓"}
          tone={unmatched.length > 0 ? "warn" : "ok"}
        />
      </div>

      {unmatched.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
            Unmatched ({unmatched.length})
          </h2>
          <div className="space-y-3">
            {unmatched.map((line) => (
              <ManualMatchClient
                key={line.id}
                bankLineId={line.id}
                transactionDate={line.transaction_date}
                description={line.description}
                reference={line.reference}
                amount={Number(line.amount_php)}
                candidates={(candidates.get(line.id) ?? []).map((c) => ({
                  id: c.id,
                  entryNumber: c.journal_entries?.entry_number ?? "—",
                  postingDate: c.journal_entries?.posting_date ?? "",
                  description: c.journal_entries?.description ?? "",
                  signed: Number(c.debit_php) - Number(c.credit_php),
                }))}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
          Matched ({matched.length})
        </h2>
        <Panel className="overflow-hidden">
          {matched.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
              Nothing matched yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Bank date</th>
                  <th className="px-4 py-3">Bank line</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Matched JE</th>
                  <th className="px-4 py-3">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {matched.map((l) => {
                  const je = Array.isArray(l.journal_lines)
                    ? null
                    : l.journal_lines?.journal_entries;
                  return (
                    <tr key={l.id}>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {l.transaction_date}
                      </td>
                      <td className="px-4 py-3">
                        {l.description ?? "—"}
                        {l.reference ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {l.reference}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {PHP.format(Number(l.amount_php))}
                      </td>
                      <td className="px-4 py-3">
                        {je ? (
                          <Link
                            href={`/staff/admin/accounting/journal/${je.id}`}
                            className="text-[color:var(--color-brand-cyan)] hover:underline"
                          >
                            <span className="font-mono text-xs">
                              {je.entry_number}
                            </span>{" "}
                            · {je.description}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {l.match_method ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </section>
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
      <p className="mt-2 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
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

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
