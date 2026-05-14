interface Row {
  provider_id: string;
  provider_name: string;
  wb_ending_php: number | null;
  staged_ar_php: number;
  variance_pct: number | null;
  severity: "green" | "yellow" | "red" | "no_reference";
}

const PESO = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const PCT = new Intl.NumberFormat("en-PH", {
  style: "percent",
  maximumFractionDigits: 2,
});

export function ReconciliationPanel({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="text-base font-semibold mb-2">Reconciliation vs HMO REFERENCE</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Per provider, computed opening AR is compared to the workbook&rsquo;s aging
        ending balance. Variance &gt; 5% blocks commit unless overridden with a
        written reason.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-[720px] w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Provider</th>
              <th className="px-3 py-2 text-right">Workbook ending</th>
              <th className="px-3 py-2 text-right">Computed opening AR</th>
              <th className="px-3 py-2 text-right">Variance ₱</th>
              <th className="px-3 py-2 text-right">Variance %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dot =
                r.severity === "green"
                  ? "bg-green-500"
                  : r.severity === "yellow"
                    ? "bg-amber-500"
                    : r.severity === "red"
                      ? "bg-red-500"
                      : "bg-gray-300";
              const variance_php =
                r.wb_ending_php != null ? r.staged_ar_php - r.wb_ending_php : null;
              return (
                <tr key={r.provider_id} className="border-t">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${dot}`}
                        aria-hidden
                      />
                      {r.provider_name}
                      {r.severity === "red" && (
                        <span className="ml-2 rounded bg-red-100 text-red-700 text-xs px-2 py-0.5 font-medium">
                          BLOCKING
                        </span>
                      )}
                      {r.severity === "no_reference" && (
                        <span className="ml-2 rounded bg-gray-100 text-gray-600 text-xs px-2 py-0.5">
                          no reference
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.wb_ending_php != null ? PESO.format(r.wb_ending_php) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {PESO.format(r.staged_ar_php)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {variance_php != null ? PESO.format(variance_php) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.variance_pct != null ? PCT.format(r.variance_pct) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
