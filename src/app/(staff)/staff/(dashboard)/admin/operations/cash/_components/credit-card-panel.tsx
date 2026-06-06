"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { groupDaysByMonth } from "@/lib/operations/daily-report";
import type { CreditCardPanel as CreditCardPanelData } from "@/lib/operations/cash-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

function fmt(value: number): string {
  if (value === 0) return "—";
  return PESO(value);
}

function dayNum(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

/** A rendered column: either a collapsed month (multiple dates) or a single day. */
interface Column {
  key: string;
  monthKey: string;
  label: string;
  dates: string[];
  isDay: boolean;
}

export function CreditCardPanel({
  panel,
  days,
}: {
  panel: CreditCardPanelData;
  days: string[];
}) {
  const months = groupDaysByMonth(days);

  // Collapsed by default — except a single-month range, which opens to days.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(months.length === 1 ? months.map((m) => m.key) : []),
  );

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const columns: Column[] = months.flatMap((m): Column[] =>
    expanded.has(m.key)
      ? m.dates.map((d): Column => ({ key: d, monthKey: m.key, label: dayNum(d), dates: [d], isDay: true }))
      : [{ key: m.key, monthKey: m.key, label: m.label, dates: m.dates, isDay: false }],
  );

  const sumOver = (dates: string[]) =>
    dates.reduce((s, d) => s + (panel.in.values[d] ?? 0), 0);

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
          {panel.totalIn === 0 ? (
            <p className="text-sm text-[color:var(--color-brand-text-soft)]">
              No card collections in this period.
            </p>
          ) : (
            <>
              <div className="pb-2 text-xs text-[color:var(--color-brand-text-soft)]">
                Columns are collapsed by month — click a month to expand its days.
              </div>
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                      <TableHead className="sticky left-0 z-20 border-r bg-muted/60 px-3 py-2 text-left font-medium text-foreground">
                        Card pay
                      </TableHead>
                      {columns.map((c) => (
                        <TableHead
                          key={c.key}
                          onClick={() => toggle(c.monthKey)}
                          title={c.isDay ? "Collapse month" : "Expand to days"}
                          className={cn(
                            "cursor-pointer px-3 py-2 text-right font-medium whitespace-nowrap text-foreground select-none hover:text-[color:var(--color-brand-navy)]",
                            !c.isDay && "bg-muted/30",
                          )}
                        >
                          {c.isDay ? c.label : `${c.label} ▸`}
                        </TableHead>
                      ))}
                      <TableHead className="border-l px-3 py-2 text-right font-medium text-foreground">
                        Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableHead
                        scope="row"
                        className="sticky left-0 z-10 border-r bg-card px-3 py-1 text-left align-middle text-xs font-normal whitespace-nowrap text-[color:var(--color-brand-text-soft)]"
                      >
                        Card collected (IN)
                      </TableHead>
                      {columns.map((c) => (
                        <TableCell
                          key={c.key}
                          className={cn(
                            "px-3 py-1 text-right font-mono text-xs whitespace-nowrap tabular-nums",
                            !c.isDay && "bg-muted/20",
                          )}
                        >
                          {fmt(sumOver(c.dates))}
                        </TableCell>
                      ))}
                      <TableCell className="border-l bg-muted/50 px-3 py-1 text-right font-mono text-xs font-semibold whitespace-nowrap tabular-nums">
                        {fmt(panel.totalIn)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </details>
    </Card>
  );
}
