import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PESO = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type OpeningJELine = {
  account_id: string;
  debit_php: number | string;
  credit_php: number | string;
};

type OpeningJE = {
  id: string;
  entry_number: string;
  description: string;
  posting_date: string;
  status: string;
  journal_lines: OpeningJELine[];
};

export default async function CommittedPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  await requireAdminStaff();
  const { runId } = await params;
  const supabase = createAdminClient();

  const { data: run } = await supabase
    .from("hmo_import_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (!run || !run.committed_at) notFound();

  const { data: openingJEs } = await supabase
    .from("journal_entries")
    .select(
      "id, entry_number, description, posting_date, status, journal_lines(account_id, debit_php, credit_php)",
    )
    .eq("source_kind", "hmo_history_opening")
    .eq("source_id", runId)
    .order("entry_number", { ascending: true });

  // Numeric keys we read by name; other JSONB keys (e.g. reconciliation_computed)
  // stay typed as unknown to avoid false-promising their shape.
  const summary = (run.summary ?? {}) as {
    patients?: number;
    visits?: number;
    test_requests?: number;
    batches?: number;
    items?: number;
    payments?: number;
    allocations?: number;
    opening_jes?: number;
    [key: string]: unknown;
  };
  // supabase-js returns a structural type for nested joins; cast to local type for readability.
  const typedOpeningJEs = (openingJEs ?? []) as unknown as OpeningJE[];

  return (
    <div className="px-4 py-6 sm:px-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Import committed</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Committed on{" "}
          {new Date(run.committed_at).toLocaleString("en-PH", {
            timeZone: "Asia/Manila",
          })}{" "}
          &middot; cutover <strong>{run.cutover_date}</strong> &middot; file{" "}
          <strong>{run.file_name}</strong>
        </p>
      </header>

      <section className="rounded-lg border p-4 mb-6 bg-green-50 border-green-200 text-green-900">
        <h2 className="font-semibold mb-2">Summary</h2>
        <ul className="text-sm space-y-1">
          <li>
            Patients created: <strong>{summary.patients ?? 0}</strong>
          </li>
          <li>
            Visits: <strong>{summary.visits ?? 0}</strong>
          </li>
          <li>
            Test requests: <strong>{summary.test_requests ?? 0}</strong>
          </li>
          <li>
            HMO claim batches: <strong>{summary.batches ?? 0}</strong>
          </li>
          <li>
            HMO claim items: <strong>{summary.items ?? 0}</strong>
          </li>
          <li>
            Payments: <strong>{summary.payments ?? 0}</strong>
          </li>
          <li>
            Payment allocations: <strong>{summary.allocations ?? 0}</strong>
          </li>
          <li>
            Opening journal entries: <strong>{summary.opening_jes ?? 0}</strong>
          </li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">Opening journal entries</h2>
        {typedOpeningJEs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No opening JEs posted (all providers had zero net AR).
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="min-w-[640px] w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">JE</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Posting date</th>
                </tr>
              </thead>
              <tbody>
                {typedOpeningJEs.map((je) => {
                  const totalDr = (je.journal_lines ?? []).reduce(
                    (a: number, l: OpeningJELine) => a + Number(l.debit_php ?? 0),
                    0,
                  );
                  // The journal-entries detail route does not exist yet (12.A
                  // ships before the JE explorer), so render the entry number
                  // as plain monospaced text rather than inventing a route.
                  return (
                    <tr key={je.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{je.entry_number}</td>
                      <td className="px-3 py-2">{je.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {PESO.format(totalDr)}
                      </td>
                      <td className="px-3 py-2">{je.posting_date}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border p-4 bg-blue-50 border-blue-200 text-blue-900">
        <h2 className="font-semibold mb-2">From here forward</h2>
        <p className="text-sm">
          NEW HMO claims must be entered through the operational UI at{" "}
          <Link
            href="/staff/admin/accounting/hmo-claims"
            className="underline"
          >
            /staff/admin/accounting/hmo-claims
          </Link>{" "}
          &mdash; do not update the workbook. Historical claims continue to appear in
          aging views alongside operational ones.
        </p>
      </section>
    </div>
  );
}
