import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countResultViews } from "@/lib/results/viewed-count";
import type { ReportUndoScope } from "@/components/staff/release/undo-release-dialog";

/**
 * UndoReleaseDialog's inputs for ONE row outside the visit page: the
 * combined-report scope and the patient's view count over the report (the
 * visit page computes the same in bulk, visits/[id]/page.tsx). Display only —
 * undoReleaseSelectedAction re-derives the scope on the server.
 */
export async function loadRowUndoContext(
  supabase: SupabaseClient,
  testRequestId: string,
): Promise<{ reportScope: ReportUndoScope | null; viewedCount: number }> {
  const { data: links } = await supabase
    .from("result_test_requests")
    .select("result_id")
    .eq("test_request_id", testRequestId);
  const resultIds = Array.from(new Set((links ?? []).map((l) => l.result_id as string)));
  let memberIds = [testRequestId];
  let label = "combined";
  if (resultIds.length > 0) {
    const { data: members } = await supabase
      .from("result_test_requests")
      .select("test_request_id, test_requests!inner ( services!inner ( report_groups ( name ) ) )")
      .in("result_id", resultIds);
    const ids = Array.from(new Set((members ?? []).map((x) => x.test_request_id as string)));
    if (ids.length > 1) {
      memberIds = ids;
      const first = members?.[0] as unknown as {
        test_requests: { services: { report_groups: { name: string } | { name: string }[] | null } };
      };
      const rg = first?.test_requests?.services?.report_groups;
      label = (Array.isArray(rg) ? rg[0]?.name : rg?.name) ?? "combined";
    }
  }
  const counts = await Promise.all(memberIds.map((id) => countResultViews(id)));
  return {
    reportScope: memberIds.length > 1 ? { memberIds, label } : null,
    viewedCount: counts.reduce((a, b) => a + b, 0),
  };
}
