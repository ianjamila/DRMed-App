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

  const created: Array<{ id: string; batch: number }> = [];
  const total = data.by_physician.length;

  // Rolls back every disbursement created so far in this batch via the SAME
  // path a manual void uses (JE reversal + soft-void + doctor_pf_entries
  // unlink + audit row — see M12), so a failed batch never strands PF entries
  // pointing at a voided-but-still-linked disbursement. Returns the payouts it
  // could NOT void, so the message never claims a clean rollback it did not do.
  async function rollbackCreated(reason: string): Promise<Array<{ batch: number; error: string }>> {
    const failed: Array<{ batch: number; error: string }> = [];
    for (const c of created) {
      try {
        const res = await voidPfDisbursementAndUnlink(admin, {
          disbursementId: c.id,
          voidedBy: staff.user_id,
          voidReason: "bulk_failed",
          auditContext: { bulk_rollback: true, batch_failure_reason: reason },
        });
        if (!res.ok) failed.push({ batch: c.batch, error: res.error });
      } catch (e) {
        failed.push({ batch: c.batch, error: e instanceof Error ? e.message : "unexpected error" });
      }
    }
    return failed;
  }

  // M12: give a partial failure a clear message — how far the batch got, what
  // was rolled back, and (0224) what could NOT be: a payout that failed to void
  // still stands, and an unreadable confirmation may have committed a payout
  // this call has no id for. "Nothing was left half-done" is said only when true.
  function partialFailureMessage(
    cause: string,
    failed: Array<{ batch: number; error: string }>,
    uncertain = false,
  ): string {
    const noun = total === 1 ? "payout" : "payouts";
    const rolledBack = created.length - failed.length;
    const notes: string[] = [];
    if (rolledBack > 0) {
      notes.push(`${rolledBack} of ${total} ${noun} in this batch were already created and have been rolled back`);
    }
    if (failed.length > 0) {
      const names = failed.map((f) => `PF-${f.batch}`).join(", ");
      notes.push(
        `${names} could not be voided again (${failed[0]!.error}) and still ${failed.length === 1 ? "stands" : "stand"} — void ${failed.length === 1 ? "it" : "them"} from Pay Doctors › Already paid`,
      );
    }
    if (uncertain) {
      notes.push("one more payout may have been recorded — check Pay Doctors › Already paid before trying again");
    }
    if (notes.length === 0) return cause;
    const clean = failed.length === 0 && !uncertain;
    return `${cause} (${notes.join("; ")}${clean ? " — nothing was left half-done." : "."})`;
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
      const failed = await rollbackCreated(message);
      return { ok: false, error: partialFailureMessage(message, failed) };
    }
    const disb = parsePayoutResult(res);
    if (!disb) {
      // The call returned without an error but its result is unreadable: it may have
      // committed a payout whose id this call does not have, so that one cannot be voided
      // here. Void what this batch DID create and say that one more may exist.
      const message =
        "A payout's confirmation couldn't be read, so the batch was stopped.";
      const failed = await rollbackCreated(message);
      return { ok: false, error: partialFailureMessage(message, failed, true) };
    }
    created.push({ id: disb.id, batch: disb.batch_number });
  }

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf_disbursement.created",
    resource_type: "doctor_pf_disbursements",
    resource_id: null,
    metadata: { bulk: true, count: created.length, posted_date: data.posted_date },
  });

  return { ok: true, data: { disbursement_ids: created.map((c) => c.id) } };
}
