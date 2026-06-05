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
import type { DailyMatrix, MatrixRow } from "@/lib/operations/daily-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const INT = (n: number) => new Intl.NumberFormat("en-PH").format(n);

function fmt(row: MatrixRow, value: number): string {
  if (value === 0) return "—";
  return row.metric === "customers" || row.metric === "count" ? INT(value) : PESO(value);
}

function dayHeader(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function MatrixDataRow({
  row,
  days,
  emphasise,
}: {
  row: MatrixRow;
  days: string[];
  emphasise?: boolean;
}) {
  return (
    <TableRow className={cn(emphasise && "font-semibold")}>
      <TableHead
        scope="row"
        className={cn(
          "sticky left-0 z-10 whitespace-nowrap border-r bg-card px-3 py-1 text-left align-middle text-xs font-normal text-foreground",
          row.channel && "pl-6 font-normal text-[color:var(--color-brand-text-soft)]",
          emphasise && "font-semibold text-[color:var(--color-brand-navy)]",
        )}
      >
        {row.label}
      </TableHead>
      {days.map((d) => (
        <TableCell
          key={d}
          className="whitespace-nowrap px-3 py-1 text-right font-mono text-xs tabular-nums"
        >
          {fmt(row, row.byDay[d] ?? 0)}
        </TableCell>
      ))}
      <TableCell className="whitespace-nowrap border-l bg-muted/50 px-3 py-1 text-right font-mono text-xs font-semibold tabular-nums">
        {fmt(row, row.total)}
      </TableCell>
    </TableRow>
  );
}

export function DailyMatrixTable({ matrix }: { matrix: DailyMatrix }) {
  const { days, sections, totals } = matrix;
  if (days.length === 0) {
    return (
      <EmptyState
        className="mt-4"
        title="No activity in this range"
        description="Pick a different month or date range above."
      />
    );
  }
  return (
    <Card className="mt-4 py-0">
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="bg-muted/60 hover:bg-muted/60">
            <TableHead className="sticky left-0 z-20 border-r bg-muted/60 px-3 py-2 text-left font-medium text-foreground">
              Metric
            </TableHead>
            {days.map((d) => (
              <TableHead
                key={d}
                className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground tabular-nums"
              >
                {dayHeader(d)}
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
                colSpan={days.length + 2}
                className="sticky left-0 bg-[color:var(--color-brand-navy)]/[0.06] px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-[color:var(--color-brand-navy)] uppercase"
              >
                {sec.title}
              </TableHead>
            </TableRow>
            {sec.rows.map((row) => (
              <MatrixDataRow
                key={`${sec.section}-${row.metric}-${row.channel ?? "total"}`}
                row={row}
                days={days}
              />
            ))}
          </TableBody>
        ))}
        <TableFooter>
          <MatrixDataRow row={totals.revenue} days={days} emphasise />
          <MatrixDataRow row={totals.discount} days={days} />
          <MatrixDataRow row={totals.net} days={days} emphasise />
        </TableFooter>
      </Table>
    </Card>
  );
}
