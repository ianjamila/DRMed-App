"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { voidPfDisbursementAndUnlink } from "@/lib/accounting/pf-disbursement-void";
import { PfBulkPayoutSchema } from "@/lib/validations/accounting";
import { parsePayoutResult } from "@/lib/accounting/pf-payout-result";

type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function createBulkPfPayoutCash(
  input: z.infer<typeof PfBulkPayoutSchema>
): Promise<ActionResult<{ disbursement_ids: string[] }>> {
  const staff = await requireAdminStaff();
  const parsed = PfBulkPayoutSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const admin = createAdminClient();

  const created: string[] = [];
  const total = data.by_physician.length;

  // Rolls back every disbursement created so far in this batch via the SAME
  // path a manual void uses (JE reversal + soft-void + doctor_pf_entries
  // unlink + audit row — see M12), so a failed batch never strands PF entries
  // pointing at a voided-but-still-linked disbursement.
  async function rollbackCreated(reason: string): Promise<void> {
    for (const id of created) {
      await voidPfDisbursementAndUnlink(admin, {
        disbursementId: id,
        voidedBy: staff.user_id,
        voidReason: "bulk_failed",
        auditContext: { bulk_rollback: true, batch_failure_reason: reason },
      });
    }
  }

  // M12: give a partial failure a clear message — today it fails silently
  // about how far the batch got before rolling back.
  function partialFailureMessage(cause: string): string {
    if (created.length === 0) return cause;
    const noun = total === 1 ? "payout" : "payouts";
    return `${cause} (${created.length} of ${total} ${noun} in this batch were already created and have been rolled back — nothing was left half-done.)`;
  }

  // Each doctor's payout is ONE SQL transaction (0224 pf_disburse_entries: lock + validate +
  // recompute the total + batch number + header/JE + link), so a refusal or failure leaves
  // nothing of THAT payout behind. The batch as a whole is still sequential: if a later
  // physician fails, the payouts already created are voided through rollbackCreated().
  for (const phys of data.by_physician) {
    const { data: res, error: rpcErr } = await admin.rpc("pf_disburse_entries", {
      p_physician_id: phys.physician_id,
      p_entry_ids: phys.entry_ids,
      p_posted_date: data.posted_date,
      p_method: "cash",
      p_total_php: phys.total_php,
      p_recorded_by: staff.user_id,
      p_notes: `Bulk EOD payout ${data.posted_date}`,
    });
    if (rpcErr) {
      const message = translatePgError(rpcErr);
      await rollbackCreated(message);
      return { ok: false, error: partialFailureMessage(message) };
    }
    const disb = parsePayoutResult(res);
    if (!disb) {
      // Unreadable confirmation: the call may have committed, so it cannot be told apart from
      // success — undo what this batch created and report it.
      const message =
        "A payout's confirmation couldn't be read, so the batch was stopped. Check Pay Doctors › Already paid before trying again.";
      await rollbackCreated(message);
      return { ok: false, error: partialFailureMessage(message) };
    }
    created.push(disb.id);
  }

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf_disbursement.created",
    resource_type: "doctor_pf_disbursements",
    resource_id: null,
    metadata: { bulk: true, count: created.length, posted_date: data.posted_date },
  });

  return { ok: true, data: { disbursement_ids: created } };
}
