import { Card } from "@/components/ui/card";
import type { DailyMatrix } from "@/lib/operations/daily-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const INT = (n: number) => new Intl.NumberFormat("en-PH").format(n);

function findRow(m: DailyMatrix, section: "lab" | "consult", metric: string) {
  return m.sections
    .find((s) => s.section === section)
    ?.rows.find((r) => r.metric === metric && r.channel === undefined);
}

/**
 * Range summary. Counts/money sum cleanly across days. "Customer-visits" is the
 * sum of each day's distinct customers (a patient seen on two days counts twice)
 * — true range-distinct is a B2 improvement; labelled honestly here.
 */
export function SummaryCards({ matrix }: { matrix: DailyMatrix }) {
  const labCount = findRow(matrix, "lab", "count")?.total ?? 0;
  const consultCount = findRow(matrix, "consult", "count")?.total ?? 0;
  const labCust = findRow(matrix, "lab", "customers")?.total ?? 0;
  const consultCust = findRow(matrix, "consult", "customers")?.total ?? 0;
  const pf = findRow(matrix, "consult", "pf")?.total ?? 0;

  const cards: { label: string; value: string }[] = [
    { label: "Customer-visits (lab + consult)", value: INT(labCust + consultCust) },
    { label: "# Lab tests", value: INT(labCount) },
    { label: "# Consults", value: INT(consultCount) },
    { label: "Gross sales", value: PESO(matrix.totals.revenue.total) },
    { label: "Discounts", value: PESO(matrix.totals.discount.total) },
    { label: "Gross profit (net)", value: PESO(matrix.totals.net.total) },
    { label: "PF collected", value: PESO(pf) },
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
