import { groupDaysByMonth } from "@/lib/operations/daily-report";
import type { HmoArMatrix, HmoArProviderRow, HmoArCell } from "@/lib/operations/hmo-ar-report";

const peso = (n: number) =>
  n === 0 ? "—" : `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function aggMonth(row: HmoArProviderRow, dates: string[]): HmoArCell {
  let billedIn = 0;
  let paidOut = 0;
  for (const d of dates) {
    billedIn += row.byDay[d].billedIn;
    paidOut += row.byDay[d].paidOut;
  }
  // Ending for the month = the ending of its LAST day (cumulative, not summed).
  const ending = dates.length ? row.byDay[dates[dates.length - 1]].ending : row.endingBalance;
  return { billedIn, paidOut, ending };
}

function Cell({ cell }: { cell: HmoArCell }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
      <div className="text-emerald-700">{peso(cell.billedIn)}</div>
      <div className="text-rose-700">{peso(cell.paidOut)}</div>
      <div className="font-semibold text-[#0b2a4a]">{peso(cell.ending)}</div>
    </td>
  );
}

export function HmoArMatrixTable({
  matrix,
  from,
  to,
}: {
  matrix: HmoArMatrix;
  from: string;
  to: string;
}) {
  const months = groupDaysByMonth(matrix.days);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const columns = sameMonth
    ? matrix.days.map((d) => ({ key: d, label: d.slice(8), dates: [d] }))
    : months.map((m) => ({ key: m.key, label: m.label, dates: m.dates }));

  const renderRow = (row: HmoArProviderRow, isTotal = false) => (
    <tr key={row.provider} className={isTotal ? "border-t-2 border-[#0b2a4a] font-semibold" : "border-t"}>
      <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left whitespace-nowrap">
        {row.provider}
      </th>
      {columns.map((c) => (
        <Cell key={c.key} cell={aggMonth(row, c.dates)} />
      ))}
      <td className="px-3 py-2 text-right font-semibold tabular-nums text-[#0b2a4a]">
        {peso(row.endingBalance)}
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-[#0b2a4a] text-white">
          <tr>
            <th className="sticky left-0 z-20 bg-[#0b2a4a] px-3 py-2 text-left">
              Provider
              <div className="text-[10px] font-normal opacity-80">In / Out / Ending</div>
            </th>
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right whitespace-nowrap">
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {matrix.providers.map((p) => renderRow(p))}
          {renderRow(matrix.total, true)}
        </tbody>
      </table>
    </div>
  );
}
