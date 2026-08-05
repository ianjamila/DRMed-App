import { Fragment } from "react";
import Link from "next/link";
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
                              carry no breakdown and say so.

                              The count-sheet link is here so an admin chasing a
                              variance can open the signed sheet straight from
                              the row, instead of navigating to the EOD page for
                              that date first. It shows even without a
                              breakdown — the sheet still carries the totals,
                              the reason and the closer. */}
                          <TableRow className="hover:bg-transparent">
                            <TableCell
                              colSpan={4}
                              className="px-3 pb-2 pt-0 text-[11px] text-muted-foreground"
                            >
                              <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                <span>{summary || "Denomination count not recorded"}</span>
                                {r.closeIds.length > 0 && (
                                  <span className="flex shrink-0 flex-wrap gap-x-3">
                                    {r.closeIds.map((id, i) => (
                                      <Link
                                        key={id}
                                        href={`/staff/payments/eod/${id}/count-sheet`}
                                        className="font-medium text-[color:var(--color-brand-cyan)] hover:underline"
                                      >
                                        {/* A day can hold more than one close
                                            (multi-shift, or a re-close after a
                                            reopen), so number them rather than
                                            render identical links. */}
                                        Count sheet
                                        {r.closeIds.length > 1 ? ` ${i + 1}` : ""}
                                      </Link>
                                    ))}
                                  </span>
                                )}
                              </span>
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
