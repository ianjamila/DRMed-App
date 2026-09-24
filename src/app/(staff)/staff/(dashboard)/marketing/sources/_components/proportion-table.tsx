import { Panel } from "@/components/ui/panel";

/**
 * A simple label/count table with an inline proportional bar — no chart
 * library. `overflow-x-auto` on the Panel keeps this readable at 390px, the
 * same pattern the Appointments page's tables use.
 */
export function ProportionTable({
  title,
  columnLabel,
  rows,
  note,
  showCancelled = false,
}: {
  title: string;
  columnLabel: string;
  rows: readonly { label: string; count: number; cancelled?: number }[];
  note: string;
  // Adds a "Cancelled / no-show" column — an explicit prop rather than
  // inferred from `rows` so the header stays stable even for a period with
  // zero rows (bookings-by-source is always zero-filled, but
  // bookings-by-campaign can genuinely have no rows for an empty period).
  showCancelled?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const colCount = showCancelled ? 4 : 3;
  return (
    <section className="mt-6">
      <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">{columnLabel}</th>
              <th className="px-4 py-3 text-right">Count</th>
              {showCancelled ? <th className="px-4 py-3 text-right">Cancelled / no-show</th> : null}
              <th className="px-4 py-3">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
                  Nothing in this period.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.label}>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">{r.label}</td>
                  <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-navy)]">
                    {r.count.toLocaleString("en-PH")}
                  </td>
                  {showCancelled ? (
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-mid)]">
                      {(r.cancelled ?? 0).toLocaleString("en-PH")}
                    </td>
                  ) : null}
                  <td className="px-4 py-3">
                    <div className="h-2 w-full max-w-[200px] overflow-hidden rounded-full bg-[color:var(--color-brand-bg-mid)]">
                      <div
                        className="h-full rounded-full bg-[color:var(--color-brand-cyan)]"
                        style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">{note}</p>
    </section>
  );
}
