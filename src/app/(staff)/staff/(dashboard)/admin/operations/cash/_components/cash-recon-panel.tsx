import { Fragment } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDenominationSummary } from "@/lib/accounting/cash-denominations";
import type { CashReconRow } from "@/lib/operations/cash-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export function CashReconPanel({ rows }: { rows: CashReconRow[] }) {
  const allUnreconciled = rows.every((r) => !r.reconciled);

  return (
    <Card className="mt-6 py-0">
      <details open>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Cash reconciliation
        </summary>
        <div className="border-t px-3 py-3">
          {allUnreconciled ? (
            <EmptyState
              title="No end-of-day closes recorded in this period"
              description="Close shifts in Cash drawer → EOD to populate."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableHead className="px-3 py-2 text-left font-medium text-foreground">
                      Date
                    </TableHead>
                    <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                      Expected
                    </TableHead>
                    <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                      Counted
                    </TableHead>
                    <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                      Variance
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows
                    .filter((r) => r.reconciled)
                    .map((r) => {
                      const summary = formatDenominationSummary(r.denominations);
                      return (
                        <Fragment key={r.day}>
                          <TableRow>
                            <TableCell className="px-3 py-1">{r.day}</TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {PESO(r.expected)}
                            </TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {PESO(r.counted)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "px-3 py-1 text-right font-mono tabular-nums",
                                r.variance < 0 && "text-destructive",
                              )}
                            >
                              {PESO(r.variance)}
                            </TableCell>
                          </TableRow>
                          {/* How the till was counted. One line — no expander
                              needed. Closes from before the count sheet shipped
                              carry no breakdown and say so. */}
                          <TableRow className="hover:bg-transparent">
                            <TableCell
                              colSpan={4}
                              className="px-3 pb-2 pt-0 text-[11px] text-muted-foreground"
                            >
                              {summary || "Denomination count not recorded"}
                            </TableCell>
                          </TableRow>
                        </Fragment>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
