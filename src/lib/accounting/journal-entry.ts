import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";
import { translatePgError } from "./pg-errors";
import { reversePfJournalLine } from "./pf-journal-reversal";
import { todayManilaISODate } from "@/lib/dates/manila";

type AdminClient = ReturnType<typeof createAdminClient>;
type JeSourceKind = Database["public"]["Enums"]["je_source_kind"];

export interface SimpleJournalEntryInput {
  /** Manila-local YYYY-MM-DD. */
  postingDate: string;
  description: string;
  sourceKind: JeSourceKind;
  sourceId: string;
  debitAccountId: string;
  creditAccountId: string;
  amountPhp: number;
  createdBy: string;
}

/**
 * Post a plain, already-balanced two-line journal entry directly from
 * application code (draft → lines → posted), for the handful of GL events
 * that don't have a dedicated DB trigger of their own (a non-cash gift-code
 * sale, gift-code redemption breakage — see 0139 / Finding 11). Mirrors the
 * draft-then-post shape every trigger-driven bridge function uses
 * (bridge_payment_insert, bridge_cash_adjustment_insert, …) so these entries
 * look identical in the ledger. `entry_number` is NOT auto-assigned by a
 * trigger for app-inserted rows (only `posting_date`'s period lock and the
 * balance-on-post check are) — mint it the same way the manual-JE screen and
 * `voidPfDisbursementAndUnlink` do, via `je_next_number`, keyed off the
 * fiscal year of `postingDate` (not "today") so a posting that lands on the
 * other side of a year boundary from when this runs still gets the right
 * series.
 *
 * Returns `null` on success, a user-facing error string otherwise (already
 * run through `translatePgError`).
 */
export async function postSimpleJournalEntry(
  admin: AdminClient,
  input: SimpleJournalEntryInput,
): Promise<string | null> {
  const fiscalYear = Number(input.postingDate.slice(0, 4));
  const { data: entryNumber, error: numErr } = await admin.rpc(
    "je_next_number",
    { p_fiscal_year: fiscalYear },
  );
  if (numErr || !entryNumber) {
    return numErr
      ? translatePgError(numErr)
      : "Could not allocate a journal entry number.";
  }

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: entryNumber,
      posting_date: input.postingDate,
      description: input.description,
      status: "draft",
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      created_by: input.createdBy,
    })
    .select("id")
    .single();
  if (jeErr || !je) {
    return jeErr ? translatePgError(jeErr) : "Could not post journal entry.";
  }

  const { error: linesErr } = await admin.from("journal_lines").insert([
    {
      entry_id: je.id,
      account_id: input.debitAccountId,
      debit_php: input.amountPhp,
      credit_php: 0,
      line_order: 1,
    },
    {
      entry_id: je.id,
      account_id: input.creditAccountId,
      debit_php: 0,
      credit_php: input.amountPhp,
      line_order: 2,
    },
  ]);
  if (linesErr) {
    return translatePgError(linesErr);
  }

  const { error: postErr } = await admin
    .from("journal_entries")
    .update({ status: "posted" })
    .eq("id", je.id);
  if (postErr) {
    return translatePgError(postErr);
  }

  return null;
}

export interface ReverseJournalEntryBySourceInput {
  sourceKind: JeSourceKind;
  sourceId: string;
  actorId: string;
  reason: string;
}

/**
 * Reverse the (at most one, per `journal_entries_one_posted_per_source`)
 * currently-posted journal entry for a given (source_kind, source_id) pair —
 * the app-code counterpart to `voidCashAdjustmentAction`'s
 * `trg_bridge_cash_adjustment_void` trigger, for JEs that
 * `postSimpleJournalEntry` posted directly rather than a trigger. Same
 * draft → mirrored reversal → posted → original 'reversed' shape as
 * `voidPfDisbursementAndUnlink` in pf-disbursement-void.ts (reuses its line
 * mirroring via `reversePfJournalLine`, which despite the name is generic —
 * debit/credit swap plus a "Reversal: " description prefix).
 *
 * A no-op (returns `null`) when nothing posted is found for that source —
 * e.g. cancelling a gift code that was never sold, or a code sold under a
 * method with no sale-side JE. Returns a user-facing error string on
 * failure; on failure the original entry is left exactly as found (posted).
 */
export async function reverseJournalEntryBySource(
  admin: AdminClient,
  input: ReverseJournalEntryBySourceInput,
): Promise<string | null> {
  const { data: original } = await admin
    .from("journal_entries")
    .select("id")
    .eq("source_kind", input.sourceKind)
    .eq("source_id", input.sourceId)
    .eq("status", "posted")
    .maybeSingle();
  if (!original) return null;

  await admin
    .from("journal_entries")
    .update({ status: "draft" })
    .eq("id", original.id);

  const { data: lines } = await admin
    .from("journal_lines")
    .select("account_id, debit_php, credit_php, description, line_order")
    .eq("entry_id", original.id)
    .order("line_order");

  // Manila-local "today", not a bare UTC cast — matches 0140's fix to the
  // trigger-driven bridges (bridge_payment_void / fn_undo_release_bridge)
  // for the same reason: a reversal made before 08:00 Manila must not post
  // to the previous UTC calendar day.
  const postingDate = todayManilaISODate();
  const fiscalYear = Number(postingDate.slice(0, 4));
  const { data: entryNumber, error: numErr } = await admin.rpc(
    "je_next_number",
    { p_fiscal_year: fiscalYear },
  );
  if (numErr || !entryNumber) {
    return numErr
      ? translatePgError(numErr)
      : "Could not allocate a journal entry number.";
  }

  const { data: revJe, error: revErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: entryNumber,
      posting_date: postingDate,
      description: `Reversal: ${input.reason}`,
      status: "draft",
      source_kind: "reversal",
      source_id: null,
      created_by: input.actorId,
      reverses: original.id,
    })
    .select("id")
    .single();

  if (revErr || !revJe || !lines) {
    // Put the original back exactly where it was found — better an
    // un-reversed entry than one stuck half-reversed in draft.
    await admin
      .from("journal_entries")
      .update({ status: "posted" })
      .eq("id", original.id);
    return revErr ? translatePgError(revErr) : "Could not reverse journal entry.";
  }

  for (const l of lines) {
    await admin.from("journal_lines").insert(reversePfJournalLine(revJe.id, l));
  }
  await admin
    .from("journal_entries")
    .update({ status: "posted" })
    .eq("id", revJe.id);
  await admin
    .from("journal_entries")
    .update({ status: "reversed", reversed_by: revJe.id })
    .eq("id", original.id);

  return null;
}
