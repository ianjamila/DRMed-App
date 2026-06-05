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
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

function Row({ row, days, emphasise }: { row: MatrixRow; days: string[]; emphasise?: boolean }) {
  return (
    <tr className={emphasise ? "border-t-2 font-semibold" : "border-t"}>
      <th
        scope="row"
        className={`sticky left-0 z-10 whitespace-nowrap border-r bg-white px-3 py-1 text-left text-xs font-normal ${
          row.channel ? "pl-6 text-[color:var(--color-brand-text-soft)]" : ""
        }`}
      >
        {row.label}
      </th>
      {days.map((d) => (
        <td key={d} className="whitespace-nowrap px-3 py-1 text-right font-mono text-xs">
          {fmt(row, row.byDay[d] ?? 0)}
        </td>
      ))}
      <td className="whitespace-nowrap border-l bg-[color:var(--color-brand-bg-soft,#f8fafc)] px-3 py-1 text-right font-mono text-xs font-semibold">
        {fmt(row, row.total)}
      </td>
    </tr>
  );
}

export function DailyMatrixTable({ matrix }: { matrix: DailyMatrix }) {
  const { days, sections, totals } = matrix;
  if (days.length === 0) {
    return <p className="mt-6 text-sm text-[color:var(--color-brand-text-soft)]">No activity in this range.</p>;
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="text-xs">
        <thead>
          <tr className="bg-[color:var(--color-brand-bg-soft,#f8fafc)]">
            <th className="sticky left-0 z-20 border-r bg-[color:var(--color-brand-bg-soft,#f8fafc)] px-3 py-2 text-left">
              Metric
            </th>
            {days.map((d) => (
              <th key={d} className="whitespace-nowrap px-3 py-2 text-right">{dayHeader(d)}</th>
            ))}
            <th className="border-l px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        {sections.map((sec) => (
          <tbody key={sec.section}>
            <tr className="bg-[color:var(--color-brand-navy)]/5">
              <th
                colSpan={days.length + 2}
                className="sticky left-0 bg-[color:var(--color-brand-navy)]/5 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-navy)]"
              >
                {sec.title}
              </th>
            </tr>
            {sec.rows.map((row) => (
              <Row key={`${sec.section}-${row.metric}-${row.channel ?? "total"}`} row={row} days={days} />
            ))}
          </tbody>
        ))}
        <tfoot>
          <Row row={totals.revenue} days={days} emphasise />
          <Row row={totals.discount} days={days} />
          <Row row={totals.net} days={days} emphasise />
        </tfoot>
      </table>
    </div>
  );
}
