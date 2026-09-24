import { Card } from "@/components/ui/card";
import type { CashFlow, CashFlowRow } from "@/lib/operations/expense-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

function rangeSum(row: CashFlowRow, days: string[]): number {
  return days.reduce((s, d) => s + (row.byDay[d] ?? 0), 0);
}

export function CashFlowPanel({ cashFlow }: { cashFlow: CashFlow }) {
  const { days, starting, collected, expenses, ending } = cashFlow;
  const last = days[days.length - 1];
  // Range view: starting = first day's starting (0); collected/expenses summed; ending = last day's.
  const lines: { label: string; value: number }[] = [
    { label: starting.label, value: days.length ? (starting.byDay[days[0]] ?? 0) : 0 },
    { label: collected.label, value: rangeSum(collected, days) },
    { label: expenses.label, value: -rangeSum(expenses, days) },
    { label: ending.label, value: last ? (ending.byDay[last] ?? 0) : 0 },
  ];
  return (
    <Card className="mt-4 px-4 py-3">
      <h2 className="text-sm font-semibold text-[color:var(--color-brand-navy)]">Cash flow</h2>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {lines.map((l, i) => (
            <tr
              key={l.label}
              className={i === lines.length - 1 ? "font-bold text-[color:var(--color-brand-navy)]" : ""}
            >
              <td className="py-0.5 pr-4">{l.label}</td>
              <td className="py-0.5 text-right font-mono tabular-nums">{PESO(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 border-t pt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Operational roll from ₱0 — not a bank-reconciled balance. Collections are cash-basis,
        expenses accrual; the ₱100/day shareholder rent is not a payment row and is excluded from collected.
      </p>
    </Card>
  );
}
