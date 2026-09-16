import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchCompleteRows, fetchCompleteRowsByIds } from "@/lib/reports/paging";

/** Fetch children separately: paging statements cannot uncap an embedded line array. */
export async function loadBankStatementSummaries(client: SupabaseClient<Database>) {
  const statements = await fetchCompleteRows((from, to) => client
    .from("bank_statements")
    .select("id, account_id, period_start, period_end, statement_label, uploaded_at, chart_of_accounts ( code, name )")
    .order("period_start", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));
  if (statements.error) throw new Error(statements.error.message);
  const rows = statements.data ?? [];

  const lines = await fetchCompleteRowsByIds(rows.map((row) => row.id), (ids, from, to) => client
    .from("bank_statement_lines")
    .select("statement_id, matched_je_line_id, amount_php")
    .in("statement_id", ids)
    .order("id", { ascending: true })
    .range(from, to));
  if (lines.error) throw new Error(lines.error.message);

  const summaries = new Map<string, { total: number; matched: number; net: number }>();
  for (const line of lines.data ?? []) {
    const summary = summaries.get(line.statement_id) ?? { total: 0, matched: 0, net: 0 };
    summary.total += 1;
    if (line.matched_je_line_id) summary.matched += 1;
    summary.net += Number(line.amount_php ?? 0);
    summaries.set(line.statement_id, summary);
  }
  return rows.map((row) => ({
    ...row,
    summary: summaries.get(row.id) ?? { total: 0, matched: 0, net: 0 },
  }));
}
