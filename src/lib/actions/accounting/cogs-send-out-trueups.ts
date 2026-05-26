"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { SendOutTrueupCreateSchema } from "@/lib/validations/accounting";

type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function createSendOutTrueup(
  input: z.infer<typeof SendOutTrueupCreateSchema>
): Promise<ActionResult<{ trueup_id: string; variance_php: number }>> {
  const staff = await requireAdminStaff();
  const parsed = SendOutTrueupCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const admin = createAdminClient();

  // Compute accrued total server-side from cogs_send_out_entries.
  const { data: entries, error: entErr } = await admin
    .from("cogs_send_out_entries")
    .select("id, unit_cost_php, accrued_at, trueup_id, voided_at")
    .eq("vendor_id", data.vendor_id)
    .gte("accrued_at", data.period_start_date)
    .lte("accrued_at", `${data.period_end_date}T23:59:59`);
  if (entErr) return { ok: false, error: translatePgError(entErr) };

  const openEntries = (entries ?? []).filter((e) => !e.trueup_id && !e.voided_at);
  const accruedTotal = openEntries.reduce((s, e) => s + Number(e.unit_cost_php), 0);
  const variance = data.billed_total_php - accruedTotal;

  // Validate bill belongs to vendor if bill_id provided.
  if (data.bill_id) {
    const { data: bill } = await admin
      .from("bills")
      .select("id, vendor_id")
      .eq("id", data.bill_id)
      .single();
    if (!bill || bill.vendor_id !== data.vendor_id) {
      return { ok: false, error: "Bill does not belong to the selected vendor" };
    }
  }

  const { data: trueup, error: insErr } = await admin
    .from("cogs_send_out_trueups")
    .insert({
      vendor_id: data.vendor_id,
      bill_id: data.bill_id ?? null,
      period_start_date: data.period_start_date,
      period_end_date: data.period_end_date,
      accrued_total_php: accruedTotal,
      billed_total_php: data.billed_total_php,
      variance_php: variance,
      matched_by: staff.user_id,
    })
    .select("id, variance_php")
    .single();
  if (insErr || !trueup) return { ok: false, error: translatePgError(insErr) };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "cogs_send_out_trueup.created",
    resource_type: "cogs_send_out_trueups",
    resource_id: trueup.id,
    metadata: {
      vendor_id: data.vendor_id,
      bill_id: data.bill_id,
      period_start: data.period_start_date,
      period_end: data.period_end_date,
      variance_php: variance,
    },
  });

  return { ok: true, data: { trueup_id: trueup.id, variance_php: variance } };
}

export async function voidSendOutTrueup(input: {
  trueup_id: string;
  void_reason: string;
}): Promise<ActionResult<{ voided: true }>> {
  const staff = await requireAdminStaff();
  if (!input.trueup_id || !input.void_reason || input.void_reason.length < 3) {
    return { ok: false, error: "Trueup id and void reason required" };
  }
  const admin = createAdminClient();

  const { data: trueup } = await admin
    .from("cogs_send_out_trueups")
    .select("id, journal_entry_id, voided_at")
    .eq("id", input.trueup_id)
    .single();
  if (!trueup) return { ok: false, error: "Trueup not found" };
  if (trueup.voided_at) return { ok: false, error: "Already voided" };

  // Reverse JE via draft-flip pattern (same as voidPfDisbursement).
  if (trueup.journal_entry_id) {
    // Step 1: original to draft
    await admin
      .from("journal_entries")
      .update({ status: "draft" })
      .eq("id", trueup.journal_entry_id);

    // Fetch lines of original
    const { data: lines } = await admin
      .from("journal_lines")
      .select("account_id, debit_php, credit_php, description, line_order")
      .eq("entry_id", trueup.journal_entry_id)
      .order("line_order");

    // Insert reversal JE
    const revYear = new Date().getFullYear();
    const revEntryNumber = `REV-SO-${revYear}-${Date.now()}`;
    const { data: revJe } = await admin
      .from("journal_entries")
      .insert({
        entry_number: revEntryNumber,
        posting_date: new Date().toISOString().slice(0, 10),
        status: "draft",
        source_kind: "reversal",
        source_id: null,
        description: `Void of send-out trueup (${input.trueup_id})`,
        created_by: staff.user_id,
        reverses: trueup.journal_entry_id,
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
      .eq("id", trueup.journal_entry_id);
  }

  await admin
    .from("cogs_send_out_trueups")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: staff.user_id,
      void_reason: input.void_reason,
    })
    .eq("id", input.trueup_id);

  // Unlink entries from this trueup
  await admin
    .from("cogs_send_out_entries")
    .update({ trueup_id: null, trued_up_at: null })
    .eq("trueup_id", input.trueup_id);

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "cogs_send_out_trueup.voided",
    resource_type: "cogs_send_out_trueups",
    resource_id: input.trueup_id,
    metadata: { void_reason: input.void_reason },
  });

  return { ok: true, data: { voided: true } };
}
