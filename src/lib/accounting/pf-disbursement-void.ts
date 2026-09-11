import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reversePfJournalLine } from "./pf-journal-reversal";

type AdminClient = ReturnType<typeof createAdminClient>;

export type VoidPfDisbursementResult =
  | { ok: true }
  | { ok: false; error: string; code?: string };

export interface VoidPfDisbursementInput {
  disbursementId: string;
  voidedBy: string;
  voidReason: string;
  /** Extra fields folded into the pf_disbursement.voided audit row's metadata
   * so a bulk rollback reads differently from a manual void in the log. */
  auditContext?: Record<string, unknown>;
}

/**
 * M12: void a doctor_pf_disbursements row AND unlink every doctor_pf_entries
 * row that points at it, reversing its journal entry along the way if one was
 * posted. Single source of truth for "what voiding a PF disbursement means" —
 * both the single-disbursement void action (pf-disbursements.ts) and the bulk
 * EOD payout's failure-rollback path (pf-bulk-payout.ts) call this instead of
 * each re-implementing (and risking drifting from) the same three steps:
 *   1. reverse the JE (draft → insert mirrored reversal lines → posted →
 *      original flipped to 'reversed'), if the disbursement ever got one
 *   2. soft-void the disbursement row
 *   3. unlink its doctor_pf_entries back to disbursement_id = null, so those
 *      PF entries are open for a future disbursement again
 * Also writes the audit row, so a rollback shows up in the trail exactly like
 * a manual void does.
 */
export async function voidPfDisbursementAndUnlink(
  admin: AdminClient,
  input: VoidPfDisbursementInput,
): Promise<VoidPfDisbursementResult> {
  const { data: disb, error: dErr } = await admin
    .from("doctor_pf_disbursements")
    .select("id, journal_entry_id, voided_at, total_php, physician_id")
    .eq("id", input.disbursementId)
    .single();
  if (dErr || !disb) {
    return {
      ok: false,
      error: dErr?.message ?? "Disbursement not found.",
      code: dErr?.code,
    };
  }
  if (disb.voided_at) {
    return { ok: false, error: "Disbursement already voided." };
  }

  if (disb.journal_entry_id) {
    // Draft-flip pattern for JE reversal (matches the single-void path this
    // was extracted from): 1) original → draft, 2) insert reversal JE,
    // 3) original → reversed.
    await admin
      .from("journal_entries")
      .update({ status: "draft" })
      .eq("id", disb.journal_entry_id);

    const { data: lines } = await admin
      .from("journal_lines")
      .select("account_id, debit_php, credit_php, description, line_order")
      .eq("entry_id", disb.journal_entry_id)
      .order("line_order");

    const revYear = new Date().getFullYear();
    const { data: nRow } = await admin.rpc("je_next_number", {
      p_fiscal_year: revYear,
    });
    const revEntryNumber = nRow as string;

    const { data: revJe } = await admin
      .from("journal_entries")
      .insert({
        entry_number: revEntryNumber,
        posting_date: new Date().toISOString().slice(0, 10),
        status: "draft",
        source_kind: "reversal",
        source_id: null,
        description: `Void of PF disbursement (${input.disbursementId})`,
        created_by: input.voidedBy,
        reverses: disb.journal_entry_id,
      })
      .select("id")
      .single();

    if (revJe && lines) {
      for (const l of lines) {
        await admin
          .from("journal_lines")
          .insert(reversePfJournalLine(revJe.id, l));
      }
      await admin
        .from("journal_entries")
        .update({ status: "posted" })
        .eq("id", revJe.id);
    }

    await admin
      .from("journal_entries")
      .update({ status: "reversed", reversed_by: revJe?.id ?? null })
      .eq("id", disb.journal_entry_id);
  }

  // Soft-void the disbursement + unlink entries — the step the bulk rollback
  // path was missing before M12 (it voided the disbursement but left every
  // doctor_pf_entries row pointing at it, stranding those PF entries: not
  // open for a fresh disbursement, but their batch is dead).
  await admin
    .from("doctor_pf_disbursements")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: input.voidedBy,
      void_reason: input.voidReason,
    })
    .eq("id", input.disbursementId);

  await admin
    .from("doctor_pf_entries")
    .update({ disbursement_id: null })
    .eq("disbursement_id", input.disbursementId);

  await audit({
    actor_id: input.voidedBy,
    actor_type: "staff",
    action: "pf_disbursement.voided",
    resource_type: "doctor_pf_disbursements",
    resource_id: input.disbursementId,
    metadata: {
      void_reason: input.voidReason,
      total_php: disb.total_php,
      ...input.auditContext,
    },
  });

  return { ok: true };
}
