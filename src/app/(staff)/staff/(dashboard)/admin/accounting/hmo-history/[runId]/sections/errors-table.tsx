interface ErrorRow {
  severity: "error" | "warning" | "info";
  source_tab: string;
  source_row_no: number;
  code: string;
  message: string;
}

export function ErrorsTable({ errors }: { errors: ErrorRow[] }) {
  if (errors.length === 0) {
    return (
      <section id="errors" className="mb-6">
        <h2 className="text-base font-semibold mb-2">Errors and warnings</h2>
        <p className="text-sm text-green-700">
          No errors or warnings — staging is clean.
        </p>
      </section>
    );
  }
  return (
    <section id="errors" className="mb-6">
      <h2 className="text-base font-semibold mb-2">
        Errors and warnings ({errors.length})
      </h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-[680px] w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Severity</th>
              <th className="px-3 py-2 text-left">Tab</th>
              <th className="px-3 py-2 text-right">Row</th>
              <th className="px-3 py-2 text-left">Code</th>
              <th className="px-3 py-2 text-left">Message</th>
            </tr>
          </thead>
          <tbody>
            {errors.slice(0, 500).map((e, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-2">
                  <span
                    className={
                      e.severity === "error"
                        ? "rounded bg-red-100 text-red-700 px-2 py-0.5 text-xs font-medium"
                        : e.severity === "warning"
                          ? "rounded bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium"
                          : "rounded bg-blue-100 text-blue-700 px-2 py-0.5 text-xs font-medium"
                    }
                  >
                    {e.severity}
                  </span>
                </td>
                <td className="px-3 py-2">{e.source_tab}</td>
                <td className="px-3 py-2 text-right tabular-nums">{e.source_row_no}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.code}</td>
                <td className="px-3 py-2">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errors.length > 500 && (
        <p className="text-xs text-muted-foreground mt-2">
          Showing first 500 of {errors.length}. Download CSV (TODO) for full list.
        </p>
      )}
    </section>
  );
}
