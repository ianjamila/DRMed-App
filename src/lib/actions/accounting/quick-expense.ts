"use server";

import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { revalidatePath } from "next/cache";
import {
  CATEGORY_TO_COA,
  MOP_TO_COA,
  type ExpenseCategory,
  type Mop,
} from "@/lib/accounting/expense-mappings";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const QuickExpenseSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  category: z.string().min(1, "Pick a category") as z.ZodType<ExpenseCategory>,
  mop: z.string().min(1, "Pick a payment source") as z.ZodType<Mop>,
  amount_php: z.number().positive("Amount must be greater than 0"),
  vendor_label: z.string().max(200).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});

export type QuickExpenseInput = z.infer<typeof QuickExpenseSchema>;

export async function createQuickExpenseAction(
  raw: QuickExpenseInput,
): Promise<ActionResult<{ id: string; entry_number: string }>> {
  const profile = await requireAdminStaff();

  const parsed = QuickExpenseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  const drCode = CATEGORY_TO_COA[input.category];
  const crCode = MOP_TO_COA[input.mop];
  if (!drCode) return { ok: false, error: `Unknown category: ${input.category}` };
  if (!crCode) return { ok: false, error: `Unknown payment source: ${input.mop}` };

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

  const fy = Number(input.expense_date.slice(0, 4));
  const { data: nextNum, error: nErr } = await admin.rpc("je_next_number", {
    p_fiscal_year: fy,
  });
  if (nErr || !nextNum) {
    return { ok: false, error: translatePgError(nErr ?? { message: "je_next_number failed" }) };
  }

  const amount = Math.round(input.amount_php * 100) / 100;
  const vendor = input.vendor_label?.trim() || null;
  const desc = vendor
    ? `${input.category} — ${vendor}`
    : input.category;
  const lineDesc = input.description?.trim() || desc;

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      entry_number: nextNum as string,
      posting_date: input.expense_date,
      description: desc.slice(0, 500),
      notes: `quick_expense | mop=${input.mop} | actor=${profile.user_id}`,
      status: "draft",
      source_kind: "manual",
      source_id: null,
      created_by: profile.user_id,
    })
    .select("id, entry_number")
    .single();
  if (jeErr || !je) {
    return { ok: false, error: translatePgError(jeErr ?? { message: "JE insert failed" }) };
  }

  const { error: lErr } = await admin.from("journal_lines").insert([
    {
      entry_id: je.id,
      account_id: drId,
      debit_php: amount,
      credit_php: 0,
      description: lineDesc.slice(0, 500),
      line_order: 1,
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

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "quick_expense.posted",
    resource_type: "journal_entry",
    resource_id: je.id,
    metadata: {
      category: input.category,
      mop: input.mop,
      amount_php: amount,
      vendor_label: vendor,
    },
  });

  revalidatePath("/staff/admin/accounting/ap");
  revalidatePath("/staff/admin/accounting/journal");

  return {
    ok: true,
    data: { id: je.id, entry_number: je.entry_number ?? "" },
  };
}
