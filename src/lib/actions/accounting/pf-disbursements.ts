"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { voidPfDisbursementAndUnlink } from "@/lib/accounting/pf-disbursement-void";
import { PfDisbursementCreateSchema } from "@/lib/validations/accounting";
import { parsePayoutResult } from "@/lib/accounting/pf-payout-result";

type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function createPfDisbursement(
  input: z.infer<typeof PfDisbursementCreateSchema>
): Promise<ActionResult<{ disbursement_id: string; batch_number: number }>> {
  const staff = await requireAdminStaff();
  const parsed = PfDisbursementCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const admin = createAdminClient();

  // 0224: the whole payout is ONE SQL transaction — it locks the entries, validates them
  // (all found, one physician, open, recognised), recomputes the total server-side (the
  // client's is a hint), allocates the batch number, inserts the header (its trigger posts
  // the JE) and links the entries. A refusal (P0085) or any failure rolls all of it back,
  // so nothing is left half-done and two payouts can never pay the same entry.
  const { data: res, error: rpcErr } = await admin.rpc("pf_disburse_entries", {
    p_physician_id: data.physician_id,
    p_entry_ids: data.entry_ids,
    p_posted_date: data.posted_date,
    p_method: data.method,
    p_total_php: data.total_php,
    p_recorded_by: staff.user_id,
    p_notes: data.notes ?? undefined,
  });
  if (rpcErr) return { ok: false, error: translatePgError(rpcErr) };
  const disb = parsePayoutResult(res);
  if (!disb) {
    // The call may have committed: don't guess — send the operator to the Already paid list.
    return {
      ok: false,
      error: "The payout may have been recorded, but the confirmation couldn't be read. Check Pay Doctors › Already paid before trying again.",
    };
  }

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf_disbursement.created",
    resource_type: "doctor_pf_disbursements",
    resource_id: disb.id,
    metadata: {
      physician_id: data.physician_id,
      method: data.method,
      total_php: data.total_php,
      entry_count: data.entry_ids.length,
      batch_number: disb.batch_number,
    },
  });

  return { ok: true, data: { disbursement_id: disb.id, batch_number: disb.batch_number } };
}

export async function voidPfDisbursement(input: {
  disbursement_id: string;
  void_reason: string;
}): Promise<ActionResult<{ voided: true }>> {
  const staff = await requireAdminStaff();
  if (!input.disbursement_id || !input.void_reason || input.void_reason.length < 3) {
    return { ok: false, error: "Disbursement id and void reason required" };
  }

  const admin = createAdminClient();

  // M12: the JE reversal + soft-void + doctor_pf_entries unlink + audit row
  // are all in voidPfDisbursementAndUnlink() (src/lib/accounting) — shared
  // with the bulk EOD payout's failure-rollback path so the two can't drift.
  const result = await voidPfDisbursementAndUnlink(admin, {
    disbursementId: input.disbursement_id,
    voidedBy: staff.user_id,
    voidReason: input.void_reason,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: translatePgError({ code: result.code, message: result.error }),
    };
  }

  return { ok: true, data: { voided: true } };
}
