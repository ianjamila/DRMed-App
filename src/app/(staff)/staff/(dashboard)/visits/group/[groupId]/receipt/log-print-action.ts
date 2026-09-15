"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { toReceiptLine } from "@/lib/visits/receipt-totals";
import {
  reconcileGroupPrintSnapshot,
  type GroupPrintSnapshot,
  type PrintTimeVisit,
} from "@/lib/visits/receipt-print-snapshot";

/**
 * Record that staff printed the combined (group) receipt — see
 * `visits/[id]/receipt/log-print-action.ts` for why this is its own audited
 * event, distinct from `receipt.viewed`. One row per print covering every
 * slip in the group, keyed by `visit_group_id` since that's what the URL
 * (and the printed page) is scoped to.
 *
 * The CONTENT of the row comes from the page's render-time `snapshot`, not
 * from whatever is live now: the page suppresses consultation-only slips and
 * soft-deleted lines, and a visit can be deleted between render and print, so
 * "the live rows of this group" is not "what was on the paper". See
 * `lib/visits/receipt-print-snapshot.ts` for the two ways that diverged, and
 * for why only ids — never figures — cross the wire.
 */
export async function logGroupReceiptPrintAction(
  groupId: string,
  snapshot: GroupPrintSnapshot,
): Promise<void> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // Deliberately unfiltered on deleted_at, on BOTH levels. This is the
  // hydration behind an audit row, not a read of current data: the snapshot
  // decides what was printed, and a visit or line deleted between render and
  // print must still resolve here or the disclosure it was part of goes
  // unrecorded. PrintButton calls window.print() before this action, so by the
  // time we get here the paper is out. Every visit in a group is the same
  // patient's (0090), so the ATTRIBUTION holds even if the first row is gone.
  const { data: visits } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, patient_id, deleted_at,
        test_requests (
          id, deleted_at, base_price_php, discount_amount_php, final_price_php,
          services ( price_php )
        )
      `,
    )
    .eq("visit_group_id", groupId);

  const groupVisits: PrintTimeVisit[] = (visits ?? []).map((v) => ({
    id: v.id,
    visitNumber: v.visit_number,
    deleted: v.deleted_at !== null,
    lines: (v.test_requests ?? []).map((tr) => {
      const line = toReceiptLine(tr);
      return { id: line.id, final: line.final, deleted: line.deleted };
    }),
  }));

  const printed = reconcileGroupPrintSnapshot(snapshot, groupVisits);

  const { ip, ua } = await ipAndAgent();

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visits?.[0]?.patient_id ?? null,
    action: "receipt.printed",
    resource_type: "visit_group",
    resource_id: groupId,
    metadata: printed,
    ip_address: ip,
    user_agent: ua,
  });
}
