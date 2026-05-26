"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const LineSchema = z.object({
  account_id: z.string().uuid(),
  debit_php: z.number().min(0).max(99_999_999),
  credit_php: z.number().min(0).max(99_999_999),
  description: z.string().max(500).optional().nullable(),
});

const TemplateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  description: z.string().max(2000).optional().nullable(),
  frequency: z.enum(["monthly", "quarterly", "annual", "on_demand"]),
  is_active: z.boolean().default(true),
  lines: z.array(LineSchema).min(2, "A template needs at least two lines."),
});

export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

async function writeTemplate(
  input: z.infer<typeof TemplateSchema>,
  templateId: string | null,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = TemplateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const data = parsed.data;

  // Soft balance check — warn at the template level if the saved lines
  // don't balance, but allow it (admin might intentionally save a half-
  // template they fill in at apply time). We only block "both sides set"
  // per line.
  for (const l of data.lines) {
    if (l.debit_php > 0 && l.credit_php > 0) {
      return {
        ok: false,
        error: "Each line can only set one of debit or credit, not both.",
      };
    }
  }

  const admin = createAdminClient();

  let id = templateId;

  if (id === null) {
    const { data: row, error } = await admin
      .from("accrual_templates")
      .insert({
        name: data.name,
        description: data.description ?? null,
        frequency: data.frequency,
        is_active: data.is_active,
        created_by: session.user_id,
      })
      .select("id")
      .single();
    if (error || !row) {
      return {
        ok: false,
        error: `Couldn't create template: ${error?.message ?? "unknown"}`,
      };
    }
    id = row.id;
  } else {
    const { error } = await admin
      .from("accrual_templates")
      .update({
        name: data.name,
        description: data.description ?? null,
        frequency: data.frequency,
        is_active: data.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      return { ok: false, error: `Couldn't update template: ${error.message}` };
    }
    await admin.from("accrual_template_lines").delete().eq("template_id", id);
  }

  if (!id) {
    return { ok: false, error: "Template id missing after write." };
  }

  const lines = data.lines.map((l, i) => ({
    template_id: id as string,
    account_id: l.account_id,
    debit_php: l.debit_php,
    credit_php: l.credit_php,
    description: l.description ?? null,
    line_order: i + 1,
  }));
  const { error: lineErr } = await admin
    .from("accrual_template_lines")
    .insert(lines);
  if (lineErr) {
    return {
      ok: false,
      error: `Couldn't insert lines: ${lineErr.message}`,
    };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: templateId
      ? "accrual_template.updated"
      : "accrual_template.created",
    resource_type: "accrual_templates",
    resource_id: id,
    metadata: {
      name: data.name,
      frequency: data.frequency,
      line_count: data.lines.length,
    },
  });

  revalidatePath("/staff/admin/accounting/accrual-templates");
  return { ok: true, id };
}

export async function createAccrualTemplate(
  input: z.infer<typeof TemplateSchema>,
) {
  return writeTemplate(input, null);
}

export async function updateAccrualTemplate(
  id: string,
  input: z.infer<typeof TemplateSchema>,
) {
  return writeTemplate(input, id);
}

export async function deactivateAccrualTemplate(
  id: string,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { error } = await admin
    .from("accrual_templates")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "accrual_template.deactivated",
    resource_type: "accrual_templates",
    resource_id: id,
  });

  revalidatePath("/staff/admin/accounting/accrual-templates");
  return { ok: true, id };
}

export async function applyAccrualTemplate(id: string): Promise<void> {
  // Just a thin redirect helper — the form rendering happens on /journal/new
  // when ?from_template=<id> is set. We don't write anything here.
  await requireAdminStaff();
  redirect(`/staff/admin/accounting/journal/new?from_template=${id}`);
}
