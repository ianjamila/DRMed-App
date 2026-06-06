import { Card } from "@/components/ui/card";
import { channelLabel } from "@/lib/operations/daily-report";
import type { CashMatrix, CashMatrixRow, CashReconRow } from "@/lib/operations/cash-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

function sumRow(row: CashMatrixRow, days: string[]): number {
  return days.reduce((s, d) => s + (row.values[d] ?? 0), 0);
}

export function CashSummaryCards({
  matrix,
  reconRows,
}: {
  matrix: CashMatrix;
  reconRows: CashReconRow[];
}) {
  const { days } = matrix;

  // Grand total collected across all days
  const totalCollected = sumRow(matrix.total, days);

  // HMO received total
  const hmoTotal = sumRow(matrix.hmoReceived, days);

  // Per-method totals (aggregated across both Lab and Consult sections)
  const methodTotals = new Map<string, number>();
  for (const sec of matrix.sections) {
    for (const row of sec.rows) {
      if (row.kind === "method" && row.method) {
        const prev = methodTotals.get(row.method) ?? 0;
        methodTotals.set(row.method, prev + sumRow(row, days));
      }
    }
  }

  // Net EOD variance — only shown if at least one day is reconciled
  const anyReconciled = reconRows.some((r) => r.reconciled);
  const netVariance = anyReconciled
    ? reconRows.filter((r) => r.reconciled).reduce((s, r) => s + r.variance, 0)
    : null;

  const cards: { label: string; value: string }[] = [
    { label: "Total collected", value: PESO(totalCollected) },
    ...Array.from(methodTotals.entries()).map(([method, amount]) => ({
      label: `${channelLabel(method)} collected`,
      value: PESO(amount),
    })),
    { label: "HMO received", value: PESO(hmoTotal) },
  ];

  if (netVariance !== null) {
    cards.push({ label: "Net EOD variance", value: PESO(netVariance) });
  }

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
