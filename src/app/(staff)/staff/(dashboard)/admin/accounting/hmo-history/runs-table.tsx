import Link from "next/link";

import { createAdminClient } from "@/lib/supabase/admin";

export async function RunsTable() {
  const supabase = createAdminClient();
  const { data: runs } = await supabase
    .from("hmo_import_runs")
    .select(
      "id, run_kind, file_name, cutover_date, uploaded_by, started_at, committed_at, error_count, warning_count, staging_count",
    )
    .order("started_at", { ascending: false })
    .limit(20);

  if (!runs || runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No runs yet. Upload a workbook above to begin.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="min-w-[860px] w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Run</th>
            <th className="px-3 py-2 text-left font-medium">File</th>
            <th className="px-3 py-2 text-left font-medium">Cutover</th>
            <th className="px-3 py-2 text-left font-medium">Started</th>
            <th className="px-3 py-2 text-right font-medium">Rows</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t hover:bg-muted/20">
              <td className="px-3 py-2 font-mono text-xs">
                <Link
                  href={`/staff/admin/accounting/hmo-history/${r.id}`}
                  className="text-primary hover:underline"
                >
                  {r.id.slice(0, 8)}…
                </Link>
              </td>
              <td className="px-3 py-2">{r.file_name}</td>
              <td className="px-3 py-2">{r.cutover_date}</td>
              <td className="px-3 py-2">
                {new Date(r.started_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.staging_count}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.error_count}</td>
              <td className="px-3 py-2">
                {r.committed_at ? (
                  <span className="text-green-700">committed</span>
                ) : r.run_kind === "dry_run" ? (
                  <span className="text-amber-700">dry-run</span>
                ) : (
                  <span className="text-gray-600">{r.run_kind}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
