import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// How many times the patient has viewed/downloaded the result behind a
// test_request. `result.downloaded` audit rows reference a test_request via
// three historical metadata shapes (audit S1):
//   (1) metadata.test_request_id — single-test download,
//   (2) resource_id = a results.id linked through result_test_requests —
//       consolidated group download,
//   (3) metadata.merged_component_ids containing it — package_consolidated
//       assembly (whose resource_id is the header test_request id).
// New rows additionally carry normalized metadata.test_request_ids (all
// writers as of this change). The shapes are NOT disjoint — a single-test
// row matches (1), (2) and the normalized array — so union by audit row id.
export async function countResultViews(testRequestId: string): Promise<number> {
  const admin = createAdminClient();
  const ids = new Set<number>();

  const base = () =>
    admin
      .from("audit_log")
      .select("id")
      .eq("action", "result.downloaded")
      .eq("resource_type", "result");

  const [byMeta, links, byMerged, byNorm] = await Promise.all([
    base().eq("metadata->>test_request_id", testRequestId),
    admin
      .from("result_test_requests")
      .select("result_id")
      .eq("test_request_id", testRequestId),
    base().contains(
      "metadata->merged_component_ids",
      JSON.stringify([testRequestId]),
    ),
    base().contains(
      "metadata->test_request_ids",
      JSON.stringify([testRequestId]),
    ),
  ]);
  byMeta.data?.forEach((r) => ids.add(r.id));
  byMerged.data?.forEach((r) => ids.add(r.id));
  byNorm.data?.forEach((r) => ids.add(r.id));

  const resultIds = links.data?.map((l) => l.result_id) ?? [];
  if (resultIds.length > 0) {
    const { data } = await base().in("resource_id", resultIds);
    data?.forEach((r) => ids.add(r.id));
  }

  return ids.size;
}
