// The FULL membership of combined reports, for the pages' display-only Release
// preflight. release_visit_results (0205 §5a) judges a combined report on every
// result_test_requests link — a member in another report group, on another
// visit, or deleted all count (the portal checks every link) — so the pages
// read the same set rather than only the panel's own live members. Deleted
// rows are deliberately INCLUDED. Fails closed: any error is { ok: false }.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchCompleteRowsByIds } from "@/lib/reports/paging";
import { isDoctorKind } from "@/lib/visits/order-lines";
import type { FullMember } from "./report-release-scope";

type Svc = { section: string | null; kind: string | null };
type Tr = {
  id: string;
  status: string;
  deleted_at: string | null;
  visit_id: string;
  is_package_header: boolean;
  // Left-joined embed: null when the service is gone, and PostgREST may hand back an array.
  services: Svc | Svc[] | null;
};
type Link = { result_id: string; test_requests: Tr | Tr[] | null };

export async function fetchReportMembers(
  client: SupabaseClient<Database>,
  resultIds: readonly string[],
): Promise<{ ok: true; byResult: Map<string, FullMember[]> } | { ok: false }> {
  const byResult = new Map<string, FullMember[]>();
  if (resultIds.length === 0) return { ok: true, byResult };

  const { data, error } = await fetchCompleteRowsByIds(resultIds, (ids, from, to) =>
    client
      .from("result_test_requests")
      .select(
        "result_id, test_request_id, test_requests ( id, status, deleted_at, visit_id, is_package_header, services ( section, kind ) )",
      )
      .in("result_id", ids)
      .order("result_id", { ascending: true })
      .order("test_request_id", { ascending: true })
      .range(from, to),
  );
  if (error || !data) return { ok: false };

  for (const row of data as unknown as Link[]) {
    const tr = Array.isArray(row.test_requests) ? row.test_requests[0] : row.test_requests;
    // A link whose test can't be read is a member we can't judge: fail closed rather than drop it.
    if (!tr) return { ok: false };
    const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
    const list = byResult.get(row.result_id) ?? [];
    list.push({
      id: tr.id,
      status: tr.status,
      deleted: tr.deleted_at !== null,
      visitId: tr.visit_id,
      section: svc?.section ?? null,
      isPackageHeader: tr.is_package_header,
      isDoctor: isDoctorKind(svc?.kind ?? ""),
    });
    byResult.set(row.result_id, list);
  }
  return { ok: true, byResult };
}
