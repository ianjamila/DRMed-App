import "server-only";

import { scheduleReleaseStaffAlert } from "@/lib/notifications/release-staff-alert";

/**
 * finalise-consolidated releases a finalised chemistry report itself (step 9)
 * when the visit is settled and nothing needs sign-off. Announce it to
 * reception only when the WHOLE report went out in that one write — a
 * payment/consent deferral or a sign-off partial sends nothing now (the later
 * release from the queue or visit page goes through releaseVisitSelection and
 * alerts then), and a zero-row concurrent release announces nothing.
 * A repeated finalisation never reaches here: the existing-PDF guard and the
 * refused finalisation commit stop it earlier.
 */
export function announceFinaliseRelease(args: {
  visitId: string;
  releaseDeferred: boolean;
  /** The ids the finalisation asked to release — duplicates count once. */
  requestedIds: string[];
  releasedCount: number;
}): void {
  if (args.releaseDeferred) return;
  const requestedCount = new Set(args.requestedIds).size;
  if (requestedCount <= 0) return;
  if (args.releasedCount !== requestedCount) return;
  scheduleReleaseStaffAlert(args.visitId, args.releasedCount);
}
