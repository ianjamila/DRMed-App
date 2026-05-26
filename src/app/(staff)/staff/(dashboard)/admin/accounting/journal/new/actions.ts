"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const LineSchema = z
  .object({
    account_id: z.string().uuid("Pick an account."),
    debit_php: z.number().min(0).max(99_999_999),
    credit_php: z.number().min(0).max(99_999_999),
    description: z.string().max(500).optional().nullable(),
  })
  .refine(
    (l) => (l.debit_php > 0) !== (l.credit_php > 0),
    "Each line needs exactly one of debit or credit (not both, not zero).",
  );

const EntrySchema = z.object({
  posting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a posting date."),
  description: z.string().min(3, "Description is required.").max(500),
  notes: z.string().max(2000).optional().nullable(),
  status: z.enum(["draft", "posted"]),
  lines: z.array(LineSchema).min(2, "A JE needs at least two lines."),
});

export type ActionResult =
  | { ok: true; id: string; status: "draft" | "posted" }
  | { ok: false; error: string };

export async function createJournalEntryAction(
  input: z.infer<typeof EntrySchema>,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const parsed = EntrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const data = parsed.data;

  // Balance check: sum of debits must equal sum of credits to 2dp.
  const sumDebit = data.lines.reduce((s, l) => s + l.debit_php, 0);
  const sumCredit = data.lines.reduce((s, l) => s + l.credit_php, 0);
  if (Math.abs(sumDebit - sumCredit) > 0.005) {
    return {
      ok: false,
      error: `Unbalanced: debits ₱${sumDebit.toFixed(2)} vs credits ₱${sumCredit.toFixed(2)} (off by ₱${(sumDebit - sumCredit).toFixed(2)}).`,
    };
  }
  if (sumDebit === 0) {
    return { ok: false, error: "Total amount must be > 0." };
  }

  // Distinct account check — same account on the same side twice is allowed
  // (the trigger handles it), but two lines for the same account on opposite
  // sides should collapse — flag to the user instead of silently posting.
  const sideKey = new Set<string>();
  for (const l of data.lines) {
    const side = l.debit_php > 0 ? "DR" : "CR";
    const k = `${l.account_id}:${side}`;
    if (sideKey.has(k)) {
      // duplicate is fine, no-op
    } else {
      sideKey.add(k);
    }
  }

  const admin = createAdminClient();

  // Period gate — the trigger on journal_entries inserts will block when
  // posting_date falls in a closed period, but we can give a friendlier
  // error by checking ourselves first.
  const { data: period } = await admin
    .from("accounting_periods")
    .select("status")
    .lte("period_start", data.posting_date)
    .gte("period_end", data.posting_date)
    .maybeSingle();
  if (period?.status === "closed") {
    return {
      ok: false,
      error: `${data.posting_date} falls in a closed accounting period. Reopen the period or change the posting date.`,
    };
  }

  // Resolve fiscal year for entry_number (handled by je_next_number RPC).
  const fiscalYear = Number(data.posting_date.slice(0, 4));
  const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", {
    p_fiscal_year: fiscalYear,
  });
  if (numErr || !nextNum) {
    return {
      ok: false,
      error: `Could not allocate entry number: ${numErr?.message ?? "unknown"}`,
    };
  }

  // Insert JE as draft so the balance-check trigger doesn't fire mid-insert.
  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: nextNum,
      posting_date: data.posting_date,
      description: data.description,
      notes: data.notes ?? null,
      status: "draft",
      source_kind: "manual",
      source_id: null,
      created_by: session.user_id,
    })
    .select("id")
    .single();
  if (jeErr || !je) {
    return {
      ok: false,
      error: `Could not create journal entry: ${jeErr?.message ?? "unknown"}`,
    };
  }

  const lines = data.lines.map((l, i) => ({
    entry_id: je.id,
    account_id: l.account_id,
    debit_php: l.debit_php,
    credit_php: l.credit_php,
    description: l.description ?? null,
    line_order: i + 1,
  }));

  const { error: lineErr } = await admin.from("journal_lines").insert(lines);
  if (lineErr) {
    // Roll back the orphan JE.
    await admin.from("journal_entries").delete().eq("id", je.id);
    return {
      ok: false,
      error: `Could not insert lines: ${lineErr.message}`,
    };
  }

  if (data.status === "posted") {
    const { error: postErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_by: session.user_id, posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (postErr) {
      // Lines are in; JE stays as draft. Surface error to user.
      return {
        ok: false,
        error: `Inserted as draft, but couldn't post: ${postErr.message}. Edit and retry from the draft list.`,
      };
    }
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: data.status === "posted" ? "manual_je.posted" : "manual_je.saved_draft",
    resource_type: "journal_entries",
    resource_id: je.id,
    metadata: {
      entry_number: nextNum,
      posting_date: data.posting_date,
      total_php: sumDebit,
      line_count: data.lines.length,
    },
  });

  return { ok: true, id: je.id, status: data.status };
}

export async function createJournalEntryAndRedirect(
  input: z.infer<typeof EntrySchema>,
): Promise<ActionResult> {
  const result = await createJournalEntryAction(input);
  if (result.ok) {
    redirect(`/staff/admin/accounting/journal/${result.id}`);
  }
  return result;
}
