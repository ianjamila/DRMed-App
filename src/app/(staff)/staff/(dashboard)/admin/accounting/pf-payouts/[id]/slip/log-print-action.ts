"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Record that an admin printed a doctor's payout acknowledgment slip.
 *
 * The slip carries patient names alongside the fees, so a print is a
 * disclosure worth a trail (RA 10173) — and when a doctor disputes a payout,
 * the audit row shows who printed which batch and when. Fired from the print
 * button rather than the page render so a stray page view doesn't inflate the
 * log; the print dialog itself can still be cancelled, so read the row as
 * "the slip was put on screen for printing".
 */
export async function logPfSlipPrintAction(
  disbursementId: string,
): Promise<Result> {
  const staff = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: disb } = await admin
    .from("doctor_pf_disbursements")
    .select("id, batch_number, posted_date, physician_id, total_php, voided_at")
    .eq("id", disbursementId)
    .maybeSingle();

  if (!disb) return { ok: false, error: "Payout not found." };

  const { ip, ua } = await ipAndAgent();

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf_disbursement.slip_printed",
    resource_type: "doctor_pf_disbursement",
    resource_id: disb.id,
    metadata: {
      batch_number: disb.batch_number,
      posted_date: disb.posted_date,
      physician_id: disb.physician_id,
      total_php: Number(disb.total_php),
      voided: Boolean(disb.voided_at),
    },
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true };
}
