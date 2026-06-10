import { Card } from "@/components/ui/card";
import type { HmoArMatrix } from "@/lib/operations/hmo-ar-report";

const peso = (n: number) =>
  `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function HmoSummaryCards({ matrix }: { matrix: HmoArMatrix }) {
  const withBalance = matrix.providers.filter((p) => p.endingBalance > 0).length;
  const cards = [
    { label: "Total HMO AR (lab)", value: peso(matrix.total.endingBalance) },
    { label: "Billed in (range)", value: peso(matrix.total.rangeBilledIn) },
    { label: "Paid out (range)", value: peso(matrix.total.rangePaidOut) },
    { label: "Providers with a balance", value: String(withBalance) },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
          <div className="mt-1 text-lg font-semibold text-[#0b2a4a]">{c.value}</div>
        </Card>
      ))}
    </div>
  );
}
