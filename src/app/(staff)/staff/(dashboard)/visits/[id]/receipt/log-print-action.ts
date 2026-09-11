"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";

/**
 * Record that staff printed a single-visit receipt (or its consultation-only
 * portal-access slip, which reuses the same print button).
 *
 * A8: the receipt discloses patient name, DRM-ID, line items and prices —
 * disclosure worth its own trail, distinct from `receipt.viewed` (fired on
 * render) the same way `pf_disbursement.slip_printed` is distinct from
 * viewing the payout page. Fired from the print button so a stray page
 * render doesn't inflate the log; the print dialog can still be cancelled,
 * so read the row as "the receipt was put on screen for printing". Never
 * logs the plain PIN — only that a slip carrying one was printed.
 */
export async function logReceiptPrintAction(visitId: string): Promise<void> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select("id, visit_number, total_php, patient_id")
    .eq("id", visitId)
    .maybeSingle();

  const { ip, ua } = await ipAndAgent();

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visit?.patient_id ?? null,
    action: "receipt.printed",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      visit_number: visit?.visit_number ?? null,
      total_php: visit ? Number(visit.total_php) : null,
    },
    ip_address: ip,
    user_agent: ua,
  });
}
