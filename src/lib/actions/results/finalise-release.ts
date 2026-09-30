import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffSession } from "@/lib/auth/require-staff";
import { releaseVisitSelection, type VisitReleaseOutcome } from "@/lib/actions/visits/release-reports";
import {
  classifyFinaliseRelease,
  type FinaliseReleaseSummary,
} from "@/lib/actions/results/finalise-release-outcome";

/**
 * finalise-consolidated step 9: release the report just finalised — WHOLE or
 * not at all — through the path the lab queue and the visit page use
 * (releaseVisitSelection, #261), which also sends the patient's "result
 * ready" notice and reception's alert for a report verified fully released.
 *
 * A member whose service needs pathologist sign-off is left at
 * 'result_uploaded' by the finalise trigger. That is checked here first, so a
 * one-test report awaiting sign-off (which the whole-report planner treats as
 * a plain row) reads as "sign-off", not as a raced release. A failed status
 * read falls through to the release, which re-pins every filter itself.
 */
export async function releaseFinalisedReport(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  resultId: string;
  testRequestIds: readonly string[];
}): Promise<FinaliseReleaseSummary & { outcome: VisitReleaseOutcome | null }> {
  const { supabase, session, visitId, resultId, testRequestIds } = args;

  const { data: statusRows, error: statusErr } = await supabase
    .from("test_requests")
    .select("id, status")
    .in("id", [...testRequestIds]);
  if (!statusErr && (statusRows ?? []).some((r) => r.status === "result_uploaded")) {
    return { releaseDeferred: true, deferredReason: "signoff", releaseNote: null, outcome: null };
  }

  const outcome = await releaseVisitSelection({
    supabase,
    session,
    visitId,
    selectedIds: testRequestIds,
    // No release-medium picker on this form: "other", markDoctorLineDoneAction's
    // convention for non-interactive releases.
    medium: "other",
    auditMeta: { source: "finalise_consolidated", result_id: resultId },
  });
  return { ...classifyFinaliseRelease(outcome, testRequestIds), outcome };
}
