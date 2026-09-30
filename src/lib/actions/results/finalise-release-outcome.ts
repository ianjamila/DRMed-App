import type { VisitReleaseOutcome } from "@/lib/actions/visits/release-reports";
import { NOT_FINISHED_PREFIX } from "@/lib/queue/report-release-scope";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

export type FinaliseDeferral = "payment" | "consent" | "signoff" | "other";

export interface FinaliseReleaseSummary {
  releaseDeferred: boolean;
  deferredReason: FinaliseDeferral | null;
  /** What the medtech is shown besides the fixed payment/consent/sign-off wording. */
  releaseNote: string | null;
}

const NOTHING_RELEASED = "The report was not released — release it from the queue.";

/**
 * finalise-consolidated releases the report it just finalised through
 * releaseVisitSelection (whole report or nothing, patient notice + reception
 * alert once it went out). This folds that outcome into what the
 * entry form shows. The report is finalised either way; a deferral only means
 * it is not in the patient's hands yet.
 */
export function classifyFinaliseRelease(
  out: VisitReleaseOutcome,
  requestedIds: readonly string[],
): FinaliseReleaseSummary {
  const requested = new Set(requestedIds);
  const released = new Set([...out.changedIds, ...out.alsoReleasedIds]);
  const releasedAll = requested.size > 0 && [...requested].every((id) => released.has(id));

  if (releasedAll) {
    return { releaseDeferred: false, deferredReason: null, releaseNote: out.warnings[0] ?? null };
  }

  const reason = out.skipped[0]?.reason ?? null;
  if (released.size === 0) {
    if (reason === RELEASE_BLOCKED_UNPAID) return deferred("payment");
    if (reason === RELEASE_BLOCKED_CONSENT) return deferred("consent");
    if (reason?.startsWith(NOT_FINISHED_PREFIX)) return deferred("signoff");
    return deferred("other", reason ?? NOTHING_RELEASED);
  }
  // Part of the selection went out and part was refused.
  return deferred("other", out.warnings[0] ?? reason ?? NOTHING_RELEASED);
}

function deferred(reason: FinaliseDeferral, note: string | null = null): FinaliseReleaseSummary {
  return { releaseDeferred: true, deferredReason: reason, releaseNote: note };
}
