"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
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

  // Fetch disbursement + entries.
  const { data: disb, error: dErr } = await admin
    .from("doctor_pf_disbursements")
    .select("id, journal_entry_id, voided_at, total_php, physician_id")
    .eq("id", input.disbursement_id)
    .single();
  if (dErr || !disb) return { ok: false, error: translatePgError(dErr) };
  if (disb.voided_at) return { ok: false, error: "Disbursement already voided" };

  // Draft-flip pattern for JE reversal (see feedback_je_cleanup_pattern.md):
  //   1. Update original JE to status='draft'
  //   2. Insert reversal JE
  //   3. Update original back to status='reversed'
  if (disb.journal_entry_id) {
    // Step 1: original to draft
    await admin
      .from("journal_entries")
      .update({ status: "draft" })
      .eq("id", disb.journal_entry_id);

    // Fetch lines of original
    const { data: lines } = await admin
      .from("journal_lines")
      .select("account_id, debit_php, credit_php, description, line_order")
      .eq("entry_id", disb.journal_entry_id)
      .order("line_order");

    // Insert reversal JE — use je_next_number (not the PF batch counter, which must
    // only increment for actual disbursements). This matches how §6.3-6.7 bridge
    // functions assign entry_numbers for reversal JEs (12.5.1c fix).
    const revYear = new Date().getFullYear();
    const { data: nRow } = await admin.rpc("je_next_number", { p_fiscal_year: revYear });
    const revEntryNumber = nRow as string;
    const { data: revJe } = await admin
      .from("journal_entries")
      .insert({
        entry_number: revEntryNumber,
        posting_date: new Date().toISOString().slice(0, 10),
        status: "draft",
        source_kind: "reversal",
        source_id: null,
        description: `Void of PF disbursement (${input.disbursement_id})`,
        created_by: staff.user_id,
        reverses: disb.journal_entry_id,
      })
      .select("id")
      .single();

    if (revJe && lines) {
      for (const l of lines) {
        await admin.from("journal_lines").insert({
          entry_id: revJe.id,
          line_order: l.line_order,
          account_id: l.account_id,
          debit_php: l.credit_php,
          credit_php: l.debit_php,
          description: `Reversal: ${l.description ?? ""}`,
        });
      }
      await admin.from("journal_entries").update({ status: "posted" }).eq("id", revJe.id);
    }

    await admin
      .from("journal_entries")
      .update({ status: "reversed", reversed_by: revJe?.id ?? null })
      .eq("id", disb.journal_entry_id);
  }

  // Soft-void the disbursement + unlink entries.
  await admin
    .from("doctor_pf_disbursements")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: staff.user_id,
      void_reason: input.void_reason,
    })
    .eq("id", input.disbursement_id);

  await admin
    .from("doctor_pf_entries")
    .update({ disbursement_id: null })
    .eq("disbursement_id", input.disbursement_id);

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf_disbursement.voided",
    resource_type: "doctor_pf_disbursements",
    resource_id: input.disbursement_id,
    metadata: { void_reason: input.void_reason, total_php: disb.total_php },
  });

  return { ok: true, data: { voided: true } };
}
