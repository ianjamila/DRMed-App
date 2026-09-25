import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchCompleteRowsByIds } from "@/lib/reports/paging";
import { sharedReportTestIds, type ResultLinkRow } from "./deletion";

/**
 * The ids among `testRequestIds` that sit on a FINISHED combined report
 * (0172, P0067), counted the way the database guard counts: a result with a
 * stored PDF and ANY other junction row — a member on another page, or a
 * deleted member, still counts. Two batched reads: the results these tests
 * are linked to, then every member of those results.
 */
export async function fetchSharedReportTestIds(
  client: SupabaseClient<Database>,
  testRequestIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (testRequestIds.length === 0) return new Set();

  const { data: own } = await fetchCompleteRowsByIds(testRequestIds, (ids, from, to) =>
    client
      .from("result_test_requests")
      .select("test_request_id, result_id, results!inner ( storage_path )")
      .in("test_request_id", ids)
      .not("results.storage_path", "is", null)
      .order("test_request_id", { ascending: true })
      .range(from, to),
  );
  const finishedResultIds = [...new Set((own ?? []).map((l) => l.result_id))];
  if (finishedResultIds.length === 0) return new Set();

  const { data: members } = await fetchCompleteRowsByIds(finishedResultIds, (ids, from, to) =>
    client
      .from("result_test_requests")
      .select("test_request_id, result_id")
      .in("result_id", ids)
      .order("test_request_id", { ascending: true })
      .range(from, to),
  );
  const links: ResultLinkRow[] = (members ?? []).map((m) => ({
    test_request_id: m.test_request_id,
    result_id: m.result_id,
    storage_path: "stored", // every result here was filtered to a stored PDF
  }));
  const wanted = new Set(testRequestIds);
  return new Set([...sharedReportTestIds(links)].filter((id) => wanted.has(id)));
}
