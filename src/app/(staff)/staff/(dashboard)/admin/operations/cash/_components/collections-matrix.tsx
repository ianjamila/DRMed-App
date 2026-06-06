"use client";

import { useState } from "react";
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
import { groupDaysByMonth } from "@/lib/operations/daily-report";
import type { CashMatrix, CashMatrixRow } from "@/lib/operations/cash-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

function fmt(value: number): string {
  if (value === 0) return "—";
  return PESO(value);
}

function dayNum(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

function sumValues(row: CashMatrixRow, dates: string[]): number {
  return dates.reduce((s, d) => s + (row.values[d] ?? 0), 0);
}

/** A rendered column: either a collapsed month (multiple dates) or a single day. */
interface Column {
  key: string;
  monthKey: string;
  label: string;
  dates: string[];
  isDay: boolean;
}

export function CollectionsMatrix({ matrix }: { matrix: CashMatrix }) {
  const { days, sections, hmoReceived, total } = matrix;
  const months = groupDaysByMonth(days);

  // Collapsed by default — except a single-month range, which opens to days.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(months.length === 1 ? months.map((m) => m.key) : []),
  );

  if (days.length === 0) {
    return (
      <EmptyState
        className="mt-4"
        title="No activity in this range"
        description="Pick a different month or date range above."
      />
    );
  }

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

  const renderRow = (row: CashMatrixRow, rowKey: string, emphasise?: boolean) => (
    <TableRow key={rowKey} className={cn(emphasise && "font-semibold")}>
      <TableHead
        scope="row"
        className={cn(
          "sticky left-0 z-10 border-r bg-card px-3 py-1 text-left align-middle text-xs font-normal whitespace-nowrap text-foreground",
          row.kind === "method" && "pl-6 font-normal text-[color:var(--color-brand-text-soft)]",
          (row.kind === "section_total" || row.kind === "grand_total") &&
            "font-semibold text-[color:var(--color-brand-navy)]",
          row.kind === "grand_total" && emphasise && "font-bold",
        )}
      >
        {row.label}
      </TableHead>
      {columns.map((c) => (
        <TableCell
          key={c.key}
          className={cn(
            "px-3 py-1 text-right font-mono text-xs whitespace-nowrap tabular-nums",
            !c.isDay && "bg-muted/20",
          )}
        >
          {fmt(sumValues(row, c.dates))}
        </TableCell>
      ))}
      <TableCell className="border-l bg-muted/50 px-3 py-1 text-right font-mono text-xs font-semibold whitespace-nowrap tabular-nums">
        {fmt(sumValues(row, days))}
      </TableCell>
    </TableRow>
  );

  return (
    <Card className="mt-4 py-0">
      <div className="px-3 pt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        Columns are collapsed by month — click a month to expand its days.
      </div>
      <div className="overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="bg-muted/60 hover:bg-muted/60">
              <TableHead className="sticky left-0 z-20 border-r bg-muted/60 px-3 py-2 text-left font-medium text-foreground">
                Method
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
          {sections.map((sec) => (
            <TableBody key={sec.title}>
              <TableRow className="bg-[color:var(--color-brand-navy)]/5 hover:bg-[color:var(--color-brand-navy)]/5">
                <TableHead
                  colSpan={columns.length + 2}
                  className="sticky left-0 bg-[color:var(--color-brand-navy)]/[0.06] px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-[color:var(--color-brand-navy)] uppercase"
                >
                  {sec.title}
                </TableHead>
              </TableRow>
              {sec.rows.map((row) =>
                renderRow(
                  row,
                  `${sec.title}-${row.kind}-${row.method ?? "total"}`,
                  row.kind === "section_total",
                ),
              )}
            </TableBody>
          ))}
          <TableBody>
            {renderRow(hmoReceived, "hmo-received")}
            {renderRow(total, "grand-total", true)}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
