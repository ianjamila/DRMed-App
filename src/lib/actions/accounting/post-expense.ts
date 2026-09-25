import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CATEGORY_TO_COA,
  MOP_TO_COA,
  isTillCashMop,
  type ExpenseCategory,
  type Mop,
} from "@/lib/accounting/expense-mappings";
import type { Database } from "@/types/database";

type SourceKind = Database["public"]["Enums"]["je_source_kind"];

export type PostExpenseResult =
  | { ok: true; data: { id: string; entry_number: string } }
  | { ok: false; error: string };

/**
 * Posts a balanced, already-paid expense as a single posted journal entry:
 *   DR <expense category account>  /  CR <payment source account>
 *
 * Used by the admin "Quick expense" form (source_kind 'manual') for every
 * payment source EXCEPT physical cash out of the till. The `notesTag` is
 * stored in `journal_entries.notes` so each surface is traceable.
 *
 * **This function must never credit 1010 Cash on Hand.** A till expense has to
 * be written as an `eod_cash_adjustments` row via `postTillCashExpense()`, or
 * the drawer never learns the money left — see `TILL_CASH_MOP` for the full
 * consequence. Both the reception Petty Cash tab and Quick expense on
 * "Clinic Cash" used to come through here; the refusal below is what keeps a
 * future caller from quietly restoring that.
 *
 * Ordering matters: insert the JE as `draft`, insert both balanced lines, THEN
 * flip to `posted` — `trg_je_status_balance_check` validates debits == credits
 * on the draft→posted transition, so the lines must exist first. On line-insert
 * failure the orphan draft is deleted.
 *
 * Auth + audit + revalidation live in the calling Server Action, not here.
 */
export async function postExpenseJournalEntry(args: {
  expense_date: string;
  category: ExpenseCategory;
  mop: Mop;
  amount_php: number;
  vendor_label: string | null;
  description: string | null;
  actorId: string;
  sourceKind: SourceKind;
  notesTag: string;
  /** 0164: the partner lab a Send Out expense paid. Set ONLY on the debit
   *  (expense) line — the credit line is the payment source, not the lab. */
  vendor_id?: string | null;
}): Promise<PostExpenseResult> {
  // Unreachable from the UI — createQuickExpenseAction routes this MOP to
  // postTillCashExpense() before ever calling here. This is the backstop that
  // keeps a future caller from reopening M1, so the message stays user-safe
  // rather than naming the internal helper.
  if (isTillCashMop(args.mop)) {
    return {
      ok: false,
      error:
        "Cash paid from the till has to go through the cash drawer so the day's count stays right. Record it under Cash Drawer › Petty Cash.",
    };
  }

  const drCode = CATEGORY_TO_COA[args.category];
  const crCode = MOP_TO_COA[args.mop];
  if (!drCode) return { ok: false, error: `Unknown category: ${args.category}` };
  if (!crCode) return { ok: false, error: `Unknown payment source: ${args.mop}` };

  const admin = createAdminClient();

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code")
    .in("code", [drCode, crCode]);
  const codeToId = new Map((accounts ?? []).map((a) => [a.code, a.id]));
  const drId = codeToId.get(drCode);
  const crId = codeToId.get(crCode);
  if (!drId || !crId) {
    return { ok: false, error: `CoA missing — DR ${drCode} / CR ${crCode}` };
  }

  const fy = Number(args.expense_date.slice(0, 4));
  const { data: nextNum, error: nErr } = await admin.rpc("je_next_number", {
    p_fiscal_year: fy,
  });
  if (nErr || !nextNum) {
    return {
      ok: false,
      error: translatePgError(nErr ?? { message: "je_next_number failed" }),
    };
  }

  const amount = Math.round(args.amount_php * 100) / 100;
  const vendor = args.vendor_label?.trim() || null;
  const desc = vendor ? `${args.category} — ${vendor}` : args.category;
  const lineDesc = args.description?.trim() || desc;

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: nextNum as string,
      posting_date: args.expense_date,
      description: desc.slice(0, 500),
      notes: `${args.notesTag} | mop=${args.mop} | actor=${args.actorId}`,
      status: "draft",
      source_kind: args.sourceKind,
      source_id: null,
      created_by: args.actorId,
    })
    .select("id, entry_number")
    .single();
  if (jeErr || !je) {
    return {
      ok: false,
      error: translatePgError(jeErr ?? { message: "JE insert failed" }),
    };
  }

  const { error: lErr } = await admin.from("journal_lines").insert([
    {
      entry_id: je.id,
      account_id: drId,
      debit_php: amount,
      credit_php: 0,
      description: lineDesc.slice(0, 500),
      line_order: 1,
      vendor_id: args.vendor_id ?? null,
    },
    {
      entry_id: je.id,
      account_id: crId,
      debit_php: 0,
      credit_php: amount,
      description: lineDesc.slice(0, 500),
      line_order: 2,
    },
  ]);
  if (lErr) {
    await admin.from("journal_entries").delete().eq("id", je.id);
    return { ok: false, error: translatePgError(lErr) };
  }

  const { error: pErr } = await admin
    .from("journal_entries")
    .update({ status: "posted", posted_at: new Date().toISOString() })
    .eq("id", je.id);
  if (pErr) return { ok: false, error: translatePgError(pErr) };

  return { ok: true, data: { id: je.id, entry_number: je.entry_number ?? "" } };
}
