"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  billPaymentCreateSchema,
  billPaymentReallocateSchema,
} from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reportError } from "@/lib/observability/report-error";
import { revalidatePath } from "next/cache";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string | null };

function firstFieldFrom(path: ReadonlyArray<PropertyKey>): string | null {
  const p = path[0];
  return typeof p === "string" ? p : null;
}

/** Cast an RPC return value to a plain object safely (no `any`). */
function asRpcObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const PAYMENTS_LIST_PATH = "/staff/admin/accounting/ap/payments";

// ---------------------------------------------------------------------------
// Typed row shapes
// ---------------------------------------------------------------------------

type BillPaymentRow = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  payment_number: string;
  payment_date: string;
  method: string;
  amount_php: number;
  cash_account_id: string;
  reference: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function listBillPaymentsAction(filter?: {
  vendor_id?: string;
  method?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ActionResult<BillPaymentRow[]>> {
  await requireAdminStaff();
  const admin = createAdminClient();

  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  let q = admin
    .from("bill_payments")
    .select(`
      id,
      vendor_id,
      vendors:vendors!vendor_id (name),
      payment_number,
      payment_date,
      method,
      amount_php,
      cash_account_id,
      reference,
      cheque_number,
      cheque_date,
      void_reason,
      voided_at,
      created_at
    `)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter?.vendor_id) q = q.eq("vendor_id", filter.vendor_id);
  if (filter?.method) q = q.eq("method", filter.method);
  if (filter?.date_from) q = q.gte("payment_date", filter.date_from);
  if (filter?.date_to) q = q.lte("payment_date", filter.date_to);
  if (filter?.search) q = q.ilike("payment_number", `%${filter.search}%`);

  const { data, error } = await q;
  if (error) {
    await reportError({ scope: "listBillPaymentsAction", error });
    return { ok: false, error: "Failed to load bill payments" };
  }

  type RawPayment = {
    id: string;
    vendor_id: string;
    vendors: { name: string } | null;
    payment_number: string;
    payment_date: string;
    method: string;
    amount_php: number;
    cash_account_id: string;
    reference: string | null;
    cheque_number: string | null;
    cheque_date: string | null;
    void_reason: string | null;
    voided_at: string | null;
    created_at: string;
  };

  const rows: BillPaymentRow[] = ((data ?? []) as RawPayment[]).map((p) => ({
    id: p.id,
    vendor_id: p.vendor_id,
    vendor_name: p.vendors?.name ?? null,
    payment_number: p.payment_number,
    payment_date: p.payment_date,
    method: p.method,
    amount_php: Number(p.amount_php),
    cash_account_id: p.cash_account_id,
    reference: p.reference,
    cheque_number: p.cheque_number,
    cheque_date: p.cheque_date,
    void_reason: p.void_reason,
    voided_at: p.voided_at,
    created_at: p.created_at,
  }));

  return { ok: true, data: rows };
}

// ---------------------------------------------------------------------------
// get (detail with nested relations)
// ---------------------------------------------------------------------------

type BillPaymentDetail = Awaited<ReturnType<typeof loadBillPayment>>;

export async function getBillPaymentAction(
  id: string
): Promise<ActionResult<NonNullable<BillPaymentDetail>>> {
  await requireAdminStaff();
  const result = await loadBillPayment(id);
  if (!result) return { ok: false, error: "Bill payment not found" };
  return { ok: true, data: result };
}

async function loadBillPayment(id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("bill_payments")
    .select(`
      *,
      vendors:vendors!vendor_id (*),
      bill_payment_allocations (
        *,
        bills (id, vendor_invoice_number, bill_date, gross_amount, outstanding_amount, status)
      )
    `)
    .eq("id", id)
    .maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function createBillPaymentAction(
  input: unknown
): Promise<ActionResult<{ payment_id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billPaymentCreateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("ap_create_bill_payment_with_allocations", {
    p_input: parsed.data,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const paymentId = String(out.payment_id ?? "");
  if (!paymentId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(PAYMENTS_LIST_PATH);
  return { ok: true, data: { payment_id: paymentId } };
}

// ---------------------------------------------------------------------------
// reallocate
// ---------------------------------------------------------------------------

export async function reallocateBillPaymentAction(
  input: unknown
): Promise<ActionResult<{ payment_id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = billPaymentReallocateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("ap_reallocate_bill_payment", {
    p_payment_id: parsed.data.payment_id,
    p_allocations: parsed.data.allocations,
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const paymentId = String(out.payment_id ?? "");
  if (!paymentId) return { ok: false, error: "Unexpected RPC response" };

  revalidatePath(`${PAYMENTS_LIST_PATH}/${parsed.data.payment_id}`);
  return { ok: true, data: { payment_id: paymentId } };
}

// ---------------------------------------------------------------------------
// void
// ---------------------------------------------------------------------------

export async function voidBillPaymentAction(
  id: string,
  reason: string
): Promise<ActionResult<{ payment_id: string; reversal_je_id: string | null; already_voided: boolean }>> {
  const profile = await requireAdminStaff();

  if (!reason || reason.trim().length < 3) {
    return { ok: false, error: "Void reason must be at least 3 characters", field: "reason" };
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("ap_void_bill_payment_cascade", {
    p_payment_id: id,
    p_reason: reason.trim(),
    p_actor_id: profile.user_id,
  });

  if (error) return { ok: false, error: translatePgError(error) };

  const out = asRpcObject(data);
  const paymentId = String(out.payment_id ?? "");
  if (!paymentId) return { ok: false, error: "Unexpected RPC response" };

  const reversalJeId = out.reversal_je_id ? String(out.reversal_je_id) : null;
  const alreadyVoided = out.already_voided === true;

  revalidatePath(`${PAYMENTS_LIST_PATH}/${id}`);
  revalidatePath(PAYMENTS_LIST_PATH);
  return { ok: true, data: { payment_id: paymentId, reversal_je_id: reversalJeId, already_voided: alreadyVoided } };
}
