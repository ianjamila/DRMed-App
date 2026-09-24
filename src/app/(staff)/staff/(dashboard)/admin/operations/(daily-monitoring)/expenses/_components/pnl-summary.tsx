import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { NetIncome } from "@/lib/operations/expense-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export function PnlSummary({
  netIncome,
  booksNet,
  statementHref,
}: {
  netIncome: NetIncome;
  booksNet: number;
  /** The income statement, already carrying this range. */
  statementHref: string;
}) {
  const rows: { label: string; value: number; strong?: boolean }[] = [
    { label: "Total gross profit (lab + consult)", value: netIncome.totalGrossProfit },
    { label: "(−) Total expenses", value: -netIncome.totalExpenses },
    { label: "= Net income (operational)", value: netIncome.totalNet, strong: true },
  ];
  const diff = booksNet - netIncome.totalNet;
  return (
    <Card className="mt-4 px-4 py-3">
      <h2 className="text-sm font-semibold text-[color:var(--color-brand-navy)]">Profit &amp; loss</h2>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.strong ? "font-bold text-[color:var(--color-brand-navy)]" : ""}>
              <td className="py-0.5 pr-4">{r.label}</td>
              <td className="py-0.5 text-right font-mono tabular-nums">{PESO(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* This line already named the other report and already explained why the
          two figures differ — the audit's "why these differ" copy was written
          here first. All it was missing was the way there, so the figure it
          quotes is now the link, carrying THIS range (Operations reads from/to,
          the statement reads start/end — hence the remap, not a passthrough). */}
      <p className="mt-2 border-t pt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Reconciliation to books — GL Income-Statement net income for this range:{" "}
        <Link
          href={statementHref}
          className="font-mono font-medium tabular-nums text-[color:var(--color-brand-cyan)] hover:underline"
        >
          {PESO(booksNet)} →
        </Link>
        {Math.abs(diff) >= 1 ? (
          <>
            {" "}
            (difference {PESO(diff)} = rent/APE/procedures revenue excluded from gross profit, plus
            accrual posting-date vs released-date timing).
          </>
        ) : null}
      </p>
    </Card>
  );
}
