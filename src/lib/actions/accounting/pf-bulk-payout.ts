"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { PfBulkPayoutSchema } from "@/lib/validations/accounting";

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

  // Atomic: if any single physician fails, void the previously-created disbursements.
  // (For simplicity here, we iterate and fail-fast; production-grade transactional
  // semantics would push this into a SECURITY DEFINER PG function. Acceptable for v1.)
  for (const phys of data.by_physician) {
    const year = new Date(data.posted_date).getFullYear();
    const { data: nRow, error: nErr } = await admin.rpc(
      "next_pf_disbursement_batch_number",
      { p_year: year }
    );
    if (nErr) {
      // Rollback previously created
      for (const id of created) {
        await admin
          .from("doctor_pf_disbursements")
          .update({ voided_at: new Date().toISOString(), voided_by: staff.user_id, void_reason: "bulk_failed" })
          .eq("id", id);
      }
      return { ok: false, error: translatePgError(nErr) };
    }
    const { data: disb, error: insErr } = await admin
      .from("doctor_pf_disbursements")
      .insert({
        batch_number: nRow as number,
        physician_id: phys.physician_id,
        posted_date: data.posted_date,
        method: "cash",
        total_php: phys.total_php,
        recorded_by: staff.user_id,
        notes: `Bulk EOD payout ${data.posted_date}`,
      })
      .select("id")
      .single();
    if (insErr || !disb) {
      for (const id of created) {
        await admin
          .from("doctor_pf_disbursements")
          .update({ voided_at: new Date().toISOString(), voided_by: staff.user_id, void_reason: "bulk_failed" })
          .eq("id", id);
      }
      return { ok: false, error: translatePgError(insErr) };
    }
    created.push(disb.id);
    await admin
      .from("doctor_pf_entries")
      .update({ disbursement_id: disb.id })
      .in("id", phys.entry_ids);
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
