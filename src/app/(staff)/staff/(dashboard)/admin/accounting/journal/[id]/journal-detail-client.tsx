"use client";

import Link from "next/link";
import { StatusBadge } from "@/lib/ui/status-badge";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type ChartAccount = { code: string; name: string };

type JournalLine = {
  id: string;
  line_order: number;
  account_id: string;
  description: string | null;
  debit_php: number;
  credit_php: number;
  chart_of_accounts: ChartAccount | ChartAccount[] | null;
};

type JeStub = { id: string; entry_number: string | null } | null;

type Je = {
  id: string;
  entry_number: string | null;
  posting_date: string;
  description: string | null;
  status: string;
  source_kind: string | null;
  source_id: string | null;
  journal_lines: JournalLine[];
  reverses_je: JeStub;
  reversed_by_je: JeStub;
  source_link: { label: string; href: string } | null;
};

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function JournalDetailClient({ je }: { je: Je }) {
  const sortedLines = [...je.journal_lines].sort((a, b) => a.line_order - b.line_order);
  const totalDebit = sortedLines.reduce((s, l) => s + Number(l.debit_php), 0);
  const totalCredit = sortedLines.reduce((s, l) => s + Number(l.credit_php), 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12 · Admin · Journal
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {je.entry_number ?? "JE"}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Posting date: <span className="font-mono">{je.posting_date}</span>
          {" · "}
          Source kind:{" "}
          <span className="font-mono">{je.source_kind ?? "—"}</span>
        </p>
        <StatusBadge status={je.status} className="mt-3" />
        {je.description && (
          <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
            {je.description}
          </p>
        )}
      </header>

      {/* Cross-link panel */}
      {(je.source_link || je.reverses_je || je.reversed_by_je) && (
        <section className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
          {je.source_link && (
            <div>
              <Link href={je.source_link.href} className="font-medium text-[color:var(--color-brand-navy)] hover:underline">
                {je.source_link.label} →
              </Link>
            </div>
          )}
          {je.reverses_je && (
            <div>
              Reverses:{" "}
              <Link
                href={`/staff/admin/accounting/journal/${je.reverses_je.id}`}
                className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
              >
                {je.reverses_je.entry_number ?? je.reverses_je.id}
              </Link>
            </div>
          )}
          {je.reversed_by_je && (
            <div>
              Reversed by:{" "}
              <Link
                href={`/staff/admin/accounting/journal/${je.reversed_by_je.id}`}
                className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
              >
                {je.reversed_by_je.entry_number ?? je.reversed_by_je.id}
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Lines */}
      <section>
        <h2 className="mb-2 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Lines
        </h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedLines.map((line) => {
                const account = pluckOne(line.chart_of_accounts);
                return (
                  <tr key={line.id}>
                    <td className="px-3 py-2 tabular-nums">{line.line_order}</td>
                    <td className="px-3 py-2 text-xs">
                      {account ? `${account.code} — ${account.name}` : line.account_id}
                    </td>
                    <td className="px-3 py-2 text-xs">{line.description ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(line.debit_php) > 0 ? PHP.format(line.debit_php) : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(line.credit_php) > 0 ? PHP.format(line.credit_php) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 text-sm">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold tabular-nums">
                  {PHP.format(totalDebit)}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold tabular-nums">
                  {PHP.format(totalCredit)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {Math.abs(totalDebit - totalCredit) > 0.005 && (
          <p className="mt-2 text-xs text-red-700" role="alert">
            Debits and credits do not balance — this should never happen for a posted JE. Investigate.
          </p>
        )}
      </section>
    </div>
  );
}
