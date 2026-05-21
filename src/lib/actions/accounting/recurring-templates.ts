"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import {
  recurringTemplateCreateSchema,
  recurringTemplateUpdateSchema,
} from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { revalidatePath } from "next/cache";
// Schema types are inferred inside actions via safeParse — no top-level aliases needed.
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string | null };

function firstFieldFrom(path: ReadonlyArray<PropertyKey>): string | null {
  const p = path[0];
  return typeof p === "string" ? p : null;
}

const RECURRING_LIST_PATH = "/staff/admin/accounting/ap/recurring";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type TemplateRow = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  description: string;
  cadence: string;
  due_day_of_month: number;
  bill_date_offset_days: number;
  amount_php: number | null;
  default_account_id: string;
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  default_wt_exempt: boolean;
  next_run_date: string;
  is_active: boolean;
  created_at: string;
};

type RawTemplateList = {
  id: string;
  vendor_id: string;
  vendors: { name: string } | null;
  description: string;
  cadence: string;
  due_day_of_month: number;
  bill_date_offset_days: number;
  amount_php: number | null;
  default_account_id: string;
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  default_wt_exempt: boolean;
  next_run_date: string;
  is_active: boolean;
  created_at: string;
};

// ---------------------------------------------------------------------------
// list + get
// ---------------------------------------------------------------------------

export async function listRecurringTemplatesAction(): Promise<ActionResult<TemplateRow[]>> {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("recurring_bill_templates")
    .select(`
      id,
      vendor_id,
      vendors:vendors!vendor_id ( name ),
      description,
      cadence,
      due_day_of_month,
      bill_date_offset_days,
      amount_php,
      default_account_id,
      default_wt_classification,
      default_wt_rate,
      default_wt_exempt,
      next_run_date,
      is_active,
      created_at
    `)
    .order("next_run_date");

  if (error) return { ok: false, error: "Failed to load recurring templates" };

  const rows: TemplateRow[] = ((data ?? []) as RawTemplateList[]).map((t) => ({
    id: t.id,
    vendor_id: t.vendor_id,
    vendor_name: t.vendors?.name ?? null,
    description: t.description,
    cadence: t.cadence,
    due_day_of_month: t.due_day_of_month,
    bill_date_offset_days: t.bill_date_offset_days,
    amount_php: t.amount_php,
    default_account_id: t.default_account_id,
    default_wt_classification: t.default_wt_classification,
    default_wt_rate: t.default_wt_rate,
    default_wt_exempt: t.default_wt_exempt,
    next_run_date: t.next_run_date,
    is_active: t.is_active,
    created_at: t.created_at,
  }));

  return { ok: true, data: rows };
}

async function loadRecurringTemplate(id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("recurring_bill_templates")
    .select(`
      *,
      vendors:vendors!vendor_id ( name ),
      bills:bills!template_id ( id, bill_number, bill_date, status )
    `)
    .eq("id", id)
    .maybeSingle();
  return data;
}

export async function getRecurringTemplateAction(
  id: string
): Promise<ActionResult<NonNullable<Awaited<ReturnType<typeof loadRecurringTemplate>>>>> {
  await requireAdminStaff();
  const result = await loadRecurringTemplate(id);
  if (!result) return { ok: false, error: "Recurring template not found" };
  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// create + update
// ---------------------------------------------------------------------------

export async function createRecurringTemplateAction(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = recurringTemplateCreateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("recurring_bill_templates")
    .insert({
      ...parsed.data,
      created_by: profile.user_id,
      updated_by: profile.user_id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "recurring_template.created",
    resource_type: "recurring_bill_template",
    resource_id: data.id,
    metadata: parsed.data,
  });

  revalidatePath(RECURRING_LIST_PATH);
  return { ok: true, data: { id: data.id } };
}

export async function updateRecurringTemplateAction(
  id: string,
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = recurringTemplateUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("recurring_bill_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Recurring template not found" };

  const { error } = await admin
    .from("recurring_bill_templates")
    .update({
      ...parsed.data,
      updated_by: profile.user_id,
    })
    .eq("id", id);

  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "recurring_template.updated",
    resource_type: "recurring_bill_template",
    resource_id: id,
    metadata: { before, after: parsed.data },
  });

  revalidatePath(RECURRING_LIST_PATH);
  revalidatePath(`${RECURRING_LIST_PATH}/${id}`);
  return { ok: true, data: { id } };
}

// ---------------------------------------------------------------------------
// deactivate + reactivate
// ---------------------------------------------------------------------------

export async function deactivateRecurringTemplateAction(id: string): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: updated, error } = await admin
    .from("recurring_bill_templates")
    .update({ is_active: false, updated_by: profile.user_id })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) return { ok: false, error: "Recurring template not found" };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "recurring_template.deactivated",
    resource_type: "recurring_bill_template",
    resource_id: id,
    metadata: { is_active: false },
  });

  revalidatePath(RECURRING_LIST_PATH);
  revalidatePath(`${RECURRING_LIST_PATH}/${id}`);
  return { ok: true, data: null };
}

export async function reactivateRecurringTemplateAction(id: string): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: updated, error } = await admin
    .from("recurring_bill_templates")
    .update({ is_active: true, updated_by: profile.user_id })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) return { ok: false, error: "Recurring template not found" };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "recurring_template.reactivated",
    resource_type: "recurring_bill_template",
    resource_id: id,
    metadata: { is_active: true },
  });

  revalidatePath(RECURRING_LIST_PATH);
  revalidatePath(`${RECURRING_LIST_PATH}/${id}`);
  return { ok: true, data: null };
}
