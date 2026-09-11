"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { voidPfDisbursementAndUnlink } from "@/lib/accounting/pf-disbursement-void";
import { PfDisbursementCreateSchema } from "@/lib/validations/accounting";

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

  // Assign batch_number via the counter function.
  const year = new Date(data.posted_date).getFullYear();
  const { data: nRow, error: nErr } = await admin.rpc(
    "next_pf_disbursement_batch_number",
    { p_year: year }
  );
  if (nErr) return { ok: false, error: translatePgError(nErr) };
  const batchNumber = nRow as number;

  // Fetch and validate selected entries.
  // Server-side total recompute; client-side total is a hint only.
  const { data: entries, error: entErr } = await admin
    .from("doctor_pf_entries")
    .select("id, pf_php, physician_id, disbursement_id, voided_at, recognized_at")
    .in("id", data.entry_ids);
  if (entErr) return { ok: false, error: translatePgError(entErr) };
  if (!entries || entries.length !== data.entry_ids.length) {
    return { ok: false, error: "One or more PF entries not found" };
  }
  for (const e of entries) {
    if (e.physician_id !== data.physician_id) {
      return { ok: false, error: "PF entries must all belong to the same physician" };
    }
    if (e.disbursement_id || e.voided_at || !e.recognized_at) {
      return { ok: false, error: "One or more PF entries are not open for disbursement" };
    }
  }
  const computedTotal = entries.reduce((s, e) => s + Number(e.pf_php), 0);
  if (Math.abs(computedTotal - data.total_php) > 0.005) {
    return { ok: false, error: `Total mismatch: expected ${computedTotal}, got ${data.total_php}` };
  }

  // Insert disbursement header — trigger emits JE.
  const { data: disb, error: insErr } = await admin
    .from("doctor_pf_disbursements")
    .insert({
      batch_number: batchNumber,
      physician_id: data.physician_id,
      posted_date: data.posted_date,
      method: data.method,
      total_php: data.total_php,
      recorded_by: staff.user_id,
      notes: data.notes ?? null,
    })
    .select("id, batch_number")
    .single();
  if (insErr || !disb) return { ok: false, error: translatePgError(insErr) };

  // Link entries to the disbursement.
  const { error: updErr } = await admin
    .from("doctor_pf_entries")
    .update({ disbursement_id: disb.id })
    .in("id", data.entry_ids);
  if (updErr) return { ok: false, error: translatePgError(updErr) };

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
