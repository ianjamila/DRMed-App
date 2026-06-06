import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CreditCardPanel as CreditCardPanelData } from "@/lib/operations/cash-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export function CreditCardPanel({
  panel,
  days,
}: {
  panel: CreditCardPanelData;
  days: string[];
}) {
  // Only show days that have any card activity
  const activeDays = days.filter((d) => (panel.in.values[d] ?? 0) !== 0);

  return (
    <Card className="mt-6 py-0">
      <details open>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Credit card (Veritas Pay)
        </summary>
        <div className="border-t px-3 py-3">
          <p className="pb-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Settlement &amp; receivable are not tracked — card receipts are booked as cash on hand.
          </p>
          {activeDays.length === 0 ? (
            <p className="text-sm text-[color:var(--color-brand-text-soft)]">
              No card collections in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableHead className="px-3 py-2 text-left font-medium text-foreground">
                      Date
                    </TableHead>
                    <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                      Card collected (IN)
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeDays.map((d) => (
                    <TableRow key={d}>
                      <TableCell className="px-3 py-1">{d}</TableCell>
                      <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                        {PESO(panel.in.values[d] ?? 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableBody>
                  <TableRow className="border-t-2 font-semibold hover:bg-transparent">
                    <TableCell className="px-3 py-1">Total</TableCell>
                    <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                      {PESO(panel.totalIn)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
