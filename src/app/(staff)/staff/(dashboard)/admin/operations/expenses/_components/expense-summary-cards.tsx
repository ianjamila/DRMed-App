import { Card } from "@/components/ui/card";
import {
  largestCategory,
  cashFlowEnding,
  type ExpenseMatrix,
  type NetIncome,
  type CashFlow,
} from "@/lib/operations/expense-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export function ExpenseSummaryCards({
  matrix,
  netIncome,
  cashFlow,
}: {
  matrix: ExpenseMatrix;
  netIncome: NetIncome;
  cashFlow: CashFlow;
}) {
  const top = largestCategory(matrix);
  const cards: { label: string; value: string }[] = [
    { label: "Total expenses", value: PESO(matrix.total.total) },
    { label: "Net income (operational)", value: PESO(netIncome.totalNet) },
    { label: "Largest category", value: top ? `${top.name} · ${PESO(top.total)}` : "—" },
    { label: "Cash-flow ending", value: PESO(cashFlowEnding(cashFlow)) },
  ];
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} size="sm" className="gap-1 px-4">
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">{c.label}</div>
          <div className="font-mono text-lg font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
            {c.value}
          </div>
        </Card>
      ))}
    </div>
  );
}
