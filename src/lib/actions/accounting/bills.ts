"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import {
  billCreateDraftSchema,
  billCreateAndPostSchema,
  billPaidOnEntrySchema,
  billUpdateDraftSchema,
} from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reportError } from "@/lib/observability/report-error";
import { revalidatePath } from "next/cache";
import type { z } from "zod";

type BillCreateDraftInput = z.infer<typeof billCreateDraftSchema>;
type BillCreateAndPostInput = z.infer<typeof billCreateAndPostSchema>;
type BillPaidOnEntryInput = z.infer<typeof billPaidOnEntrySchema>;
type BillUpdateDraftInput = z.infer<typeof billUpdateDraftSchema>;

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string | null };

function firstFieldFrom(path: ReadonlyArray<PropertyKey>): string | null {
  const p = path[0];
  return typeof p === "string" ? p : null;
}

/** Cast an RPC return value to a plain object safely (no `any`). */
function asRpcObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const BILLS_LIST_PATH = "/staff/admin/accounting/ap/bills";

// ---------------------------------------------------------------------------
// list + get
// ---------------------------------------------------------------------------

type BillRow = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  gross_amount: number;
  wt_amount: number;
  outstanding_amount: number;
  status: string;
  description: string | null;
  created_at: string;
};

export async function listBillsAction(filter?: {
  vendor_id?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  has_wt?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ActionResult<BillRow[]>> {
  await requireAdminStaff();
  const admin = createAdminClient();

  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  let q = admin
    .from("bills")
    .select(`
      id,
      vendor_id,
      vendors:vendors!vendor_id (name),
      vendor_invoice_number,
      bill_date,
      due_date,
      gross_amount,
      wt_amount,
      outstanding_amount,
      status,
      description,
      created_at
    `)
    .order("bill_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter?.vendor_id) q = q.eq("vendor_id", filter.vendor_id);
  if (filter?.status) q = q.eq("status", filter.status);
  if (filter?.date_from) q = q.gte("bill_date", filter.date_from);
  if (filter?.date_to) q = q.lte("bill_date", filter.date_to);
  if (filter?.has_wt) q = q.gt("wt_amount", 0);
  if (filter?.search) q = q.ilike("vendor_invoice_number", `%${filter.search}%`);

  const { data, error } = await q;
  if (error) {
    await reportError({ scope: "listBillsAction", error });
    return { ok: false, error: "Failed to load bills" };
  }

  type RawBill = {
    id: string;
    vendor_id: string;
    vendors: { name: string } | null;
    vendor_invoice_number: string | null;
    bill_date: string;
    due_date: string;
    gross_amount: number;
    wt_amount: number;
    outstanding_amount: number;
    status: string;
    description: string | null;
    created_at: string;
  };

  const rows: BillRow[] = ((data ?? []) as RawBill[]).map((b) => ({
    id: b.id,
    vendor_id: b.vendor_id,
    vendor_name: b.vendors?.name ?? null,
    vendor_invoice_number: b.vendor_invoice_number,
    bill_date: b.bill_date,
    due_date: b.due_date,
    gross_amount: Number(b.gross_amount),
    wt_amount: Number(b.wt_amount),
    outstanding_amount: Number(b.outstanding_amount),
    status: b.status,
    description: b.description,
    created_at: b.created_at,
  }));

  return { ok: true, data: rows };
}

// Narrow type for the detail query — keeps loader/action return type precise.
type BillDetail = Awaited<ReturnType<typeof loadBill>>;

export async function getBillAction(
  id: string
): Promise<ActionResult<NonNullable<BillDetail>>> {
  await requireAdminStaff();
  const result = await loadBill(id);
  if (!result) return { ok: false, error: "Bill not found" };
  return { ok: true, data: result };
}

async function loadBill(id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("bills")
    .select(`
      *,
      vendors:vendors!vendor_id (*),
      bill_lines (*),
      bill_payment_allocations (*),
      bill_attachments (*)
    `)
    .eq("id", id)
    .maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// create (three variants)
// ---------------------------------------------------------------------------

export async function createBillDraftAction(
  input: BillCreateDraftInput
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billCreateDraftSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  // Server-side vendor active check
  const { data: vendor } = await admin
    .from("vendors")
    .select("is_active")
    .eq("id", parsed.data.vendor_id)
    .maybeSingle();
  if (!vendor || !vendor.is_active) {
    return { ok: false, error: "Vendor is inactive", field: "vendor_id" };
  }

  const { data, error } = await admin.rpc("ap_create_bill_draft", {
    p_input: parsed.data,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const billId = String(out.bill_id ?? "");
  if (!billId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: { id: billId } };
}

export async function createBillAndPostAction(
  input: BillCreateAndPostInput
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billCreateAndPostSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  // Server-side vendor active check
  const { data: vendor } = await admin
    .from("vendors")
    .select("is_active")
    .eq("id", parsed.data.vendor_id)
    .maybeSingle();
  if (!vendor || !vendor.is_active) {
    return { ok: false, error: "Vendor is inactive", field: "vendor_id" };
  }

  const { data, error } = await admin.rpc("ap_create_bill_and_post", {
    p_input: parsed.data,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const billId = String(out.bill_id ?? "");
  if (!billId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: { id: billId } };
}

export async function createBillPaidOnEntryAction(
  input: BillPaidOnEntryInput
): Promise<ActionResult<{ id: string; payment_id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billPaidOnEntrySchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  // Server-side vendor active check
  const { data: vendor } = await admin
    .from("vendors")
    .select("is_active")
    .eq("id", parsed.data.vendor_id)
    .maybeSingle();
  if (!vendor || !vendor.is_active) {
    return { ok: false, error: "Vendor is inactive", field: "vendor_id" };
  }

  const { data, error } = await admin.rpc("ap_create_bill_paid_on_entry", {
    p_input: parsed.data,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const billId = String(out.bill_id ?? "");
  const paymentId = String(out.payment_id ?? "");
  if (!billId || !paymentId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: { id: billId, payment_id: paymentId } };
}

// ---------------------------------------------------------------------------
// update (draft only)
// ---------------------------------------------------------------------------

export async function updateBillDraftAction(
  id: string,
  input: BillUpdateDraftInput
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billUpdateDraftSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("ap_update_bill_draft", {
    p_bill_id: id,
    p_input: parsed.data,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const billId = String(out.bill_id ?? "");
  if (!billId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(`${BILLS_LIST_PATH}/${id}`);
  return { ok: true, data: { id: billId } };
}

// ---------------------------------------------------------------------------
// post (direct UPDATE — ap_bill_post_bridge trigger fires on draft → posted)
// ---------------------------------------------------------------------------

export async function postBillAction(id: string): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: b } = await admin
    .from("bills")
    .select("gross_amount, wt_rate, wt_exempt, status")
    .eq("id", id)
    .maybeSingle();
  if (!b) return { ok: false, error: "Bill not found" };
  if (b.status !== "draft") return { ok: false, error: "Only draft bills can be posted" };

  const wt =
    b.wt_exempt || !b.wt_rate
      ? 0
      : Number((Number(b.gross_amount) * Number(b.wt_rate)).toFixed(2));

  const { data: updated, error } = await admin
    .from("bills")
    .update({
      wt_amount: wt,
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: profile.user_id,
    })
    .eq("id", id)
    .eq("status", "draft")
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: "Bill could not be posted — it may have changed status",
    };
  }

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "bill.posted",
    resource_type: "bill",
    resource_id: id,
    metadata: { wt_amount: wt },
  });

  revalidatePath(`${BILLS_LIST_PATH}/${id}`);
  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: { id } };
}

// ---------------------------------------------------------------------------
// delete (draft only)
// ---------------------------------------------------------------------------

export async function deleteBillDraftAction(id: string): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  // Verify the bill exists and is a draft
  const { data: bill } = await admin
    .from("bills")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!bill) return { ok: false, error: "Bill not found" };
  if (bill.status !== "draft") {
    return { ok: false, error: "Only draft bills can be deleted" };
  }

  // Collect attachment storage paths before deleting
  const { data: atts } = await admin
    .from("bill_attachments")
    .select("storage_path")
    .eq("bill_id", id) as { data: { storage_path: string }[] | null };

  if (atts && atts.length > 0) {
    const paths = atts.map((a) => a.storage_path).filter(Boolean);
    if (paths.length > 0) {
      // Best-effort — don't block deletion if storage cleanup fails
      await admin.storage.from("bill-attachments").remove(paths);
    }
  }

  const { error } = await admin.from("bills").delete().eq("id", id).eq("status", "draft");
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "bill.draft_deleted",
    resource_type: "bill",
    resource_id: id,
  });

  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// void
// ---------------------------------------------------------------------------

export async function voidBillAction(
  id: string,
  reason: string
): Promise<ActionResult<{ id: string; reversal_je_id: string | null; already_voided: boolean }>> {
  const profile = await requireAdminStaff();

  if (!reason || reason.trim().length < 3) {
    return { ok: false, error: "Void reason must be at least 3 characters", field: "reason" };
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("ap_void_bill_with_guard", {
    p_bill_id: id,
    p_reason: reason.trim(),
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const billId = String(out.bill_id ?? "");
  if (!billId) return { ok: false, error: "Unexpected RPC response" };

  const reversalJeId = out.reversal_je_id ? String(out.reversal_je_id) : null;
  const alreadyVoided = out.already_voided === true;

  revalidatePath(`${BILLS_LIST_PATH}/${id}`);
  revalidatePath(BILLS_LIST_PATH);
  return { ok: true, data: { id: billId, reversal_je_id: reversalJeId, already_voided: alreadyVoided } };
}
