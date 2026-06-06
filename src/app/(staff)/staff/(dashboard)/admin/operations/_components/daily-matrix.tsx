"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  groupDaysByMonth,
  type DailyMatrix,
  type MatrixRow,
  type MetricKind,
} from "@/lib/operations/daily-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const INT = (n: number) => new Intl.NumberFormat("en-PH").format(n);

function isMoney(metric: MetricKind): boolean {
  return metric !== "customers" && metric !== "count";
}

function fmt(metric: MetricKind, value: number): string {
  if (value === 0) return "—";
  return isMoney(metric) ? PESO(value) : INT(value);
}

function dayNum(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

function sumDates(byDay: Record<string, number>, dates: string[]): number {
  let s = 0;
  for (const d of dates) s += byDay[d] ?? 0;
  return s;
}

/** A rendered column: either a collapsed month (multiple dates) or a single day. */
interface Column {
  key: string;
  monthKey: string;
  label: string;
  dates: string[];
  isDay: boolean;
}

export function DailyMatrixTable({
  matrix,
  expensesByDay,
}: {
  matrix: DailyMatrix;
  expensesByDay: Record<string, number>;
}) {
  const { days, sections, totals } = matrix;
  const months = groupDaysByMonth(days);

  // Collapsed by default — except a single-month range, which opens to days so
  // picking "This month" still shows the day-by-day breakdown.
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

  // Flatten months into the visible columns.
  const columns: Column[] = months.flatMap((m): Column[] =>
    expanded.has(m.key)
      ? m.dates.map((d): Column => ({ key: d, monthKey: m.key, label: dayNum(d), dates: [d], isDay: true }))
      : [{ key: m.key, monthKey: m.key, label: m.label, dates: m.dates, isDay: false }],
  );

  // Expenses + rough net derived rows (footer). Net = revenue net − expenses.
  const expensesRow: MatrixRow = {
    label: "Expenses (all, from books)",
    metric: "net",
    byDay: expensesByDay,
    total: sumDates(
      expensesByDay,
      days,
    ),
  };
  const netRow: MatrixRow = {
    label: "Net (rough = profit − expenses)",
    metric: "net",
    byDay: Object.fromEntries(days.map((d) => [d, (totals.net.byDay[d] ?? 0) - (expensesByDay[d] ?? 0)])),
    total: totals.net.total - expensesRow.total,
  };

  const valueFor = (row: MatrixRow, col: Column): number => sumDates(row.byDay, col.dates);

  // Plain render helper (not a nested component) so React doesn't remount it per render.
  const renderRow = (row: MatrixRow, rowKey: string, emphasise?: boolean) => (
    <TableRow key={rowKey} className={cn(emphasise && "font-semibold")}>
      <TableHead
        scope="row"
        className={cn(
          "sticky left-0 z-10 border-r bg-card px-3 py-1 text-left align-middle text-xs font-normal whitespace-nowrap text-foreground",
          row.channel && "pl-6 font-normal text-[color:var(--color-brand-text-soft)]",
          emphasise && "font-semibold text-[color:var(--color-brand-navy)]",
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
          {fmt(row.metric, valueFor(row, c))}
        </TableCell>
      ))}
      <TableCell className="border-l bg-muted/50 px-3 py-1 text-right font-mono text-xs font-semibold whitespace-nowrap tabular-nums">
        {fmt(row.metric, row.total)}
      </TableCell>
    </TableRow>
  );

  return (
    <Card className="mt-4 py-0">
      <div className="px-3 pt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        Columns are collapsed by month — click a month to expand its days.
      </div>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="bg-muted/60 hover:bg-muted/60">
            <TableHead className="sticky left-0 z-20 border-r bg-muted/60 px-3 py-2 text-left font-medium text-foreground">
              Metric
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
          <TableBody key={sec.section}>
            <TableRow className="bg-[color:var(--color-brand-navy)]/5 hover:bg-[color:var(--color-brand-navy)]/5">
              <TableHead
                colSpan={columns.length + 2}
                className="sticky left-0 bg-[color:var(--color-brand-navy)]/[0.06] px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-[color:var(--color-brand-navy)] uppercase"
              >
                {sec.title}
              </TableHead>
            </TableRow>
            {sec.rows.map((row) =>
              renderRow(row, `${sec.section}-${row.metric}-${row.channel ?? "total"}`),
            )}
          </TableBody>
        ))}
        <TableFooter>
          {renderRow(totals.revenue, "t-revenue", true)}
          {renderRow(totals.discount, "t-discount")}
          {renderRow(totals.net, "t-net", true)}
          {renderRow(expensesRow, "t-expenses")}
          {renderRow(netRow, "t-net-rough", true)}
        </TableFooter>
      </Table>
    </Card>
  );
}
