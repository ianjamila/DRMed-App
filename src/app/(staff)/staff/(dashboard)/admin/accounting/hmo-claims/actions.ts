"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CreateClaimBatchSchema,
  AddItemsToBatchSchema,
  RemoveItemFromBatchSchema,
  SubmitBatchSchema,
  AcknowledgeBatchSchema,
  VoidBatchSchema,
  UpdateItemHmoResponseSchema,
  BulkSetHmoResponseSchema,
  CreateResolutionSchema,
  VoidResolutionSchema,
  RecordHmoSettlementSchema,
  AllocateExistingPaymentSchema,
} from "@/lib/validations/accounting";

export type ActionResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function auditMeta() {
  const h = await headers();
  return {
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  };
}

const BASE_PATH = "/staff/admin/accounting/hmo-claims";

// ============================================================
// Batch CRUD
// ============================================================

export async function createClaimBatchAction(
  input: unknown,
): Promise<ActionResult<{ batch_id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateClaimBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  // Load test_requests + verify each is released-with-HMO + matches provider + unbatched.
  const { data: trs, error: trErr } = await admin
    .from("test_requests")
    .select("id, visit_id, hmo_approved_amount_php, status, visits!inner(hmo_provider_id)")
    .in("id", parsed.data.test_request_ids);
  if (trErr) return { ok: false, error: translatePgError(trErr) };
  if (!trs || trs.length !== parsed.data.test_request_ids.length) {
    return { ok: false, error: "One or more test requests not found." };
  }
  for (const tr of trs) {
    if (tr.status !== "released") return { ok: false, error: "All items must be released." };
    if (
      (tr as unknown as { visits: { hmo_provider_id: string | null } }).visits.hmo_provider_id !==
      parsed.data.provider_id
    ) {
      return { ok: false, error: "All items must belong to the selected provider." };
    }
    if (!tr.hmo_approved_amount_php || Number(tr.hmo_approved_amount_php) <= 0) {
      return { ok: false, error: "Items must have hmo_approved_amount_php > 0." };
    }
  }

  // Insert batch
  const { data: batch, error: bErr } = await admin
    .from("hmo_claim_batches")
    .insert({ provider_id: parsed.data.provider_id, status: "draft" })
    .select("id")
    .single();
  if (bErr || !batch) {
    return { ok: false, error: translatePgError(bErr ?? { message: "insert failed" }) };
  }

  // Insert items
  const rows = trs.map((tr) => ({
    batch_id: batch.id,
    test_request_id: tr.id,
    billed_amount_php: tr.hmo_approved_amount_php as number,
  }));
  const { error: iErr } = await admin.from("hmo_claim_items").insert(rows);
  if (iErr) {
    // Best-effort cleanup of the empty batch.
    await admin.from("hmo_claim_batches").delete().eq("id", batch.id);
    return { ok: false, error: translatePgError(iErr) };
  }

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.created",
    resource_type: "hmo_claim_batch",
    resource_id: batch.id,
    metadata: {
      provider_id: parsed.data.provider_id,
      item_count: rows.length,
      total_billed_php: rows.reduce((a, r) => a + Number(r.billed_amount_php), 0),
    },
    ...meta,
  });

  revalidatePath(BASE_PATH);
  return { ok: true, data: { batch_id: batch.id } };
}

export async function addItemsToBatchAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = AddItemsToBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();
  const { data: batch } = await admin
    .from("hmo_claim_batches")
    .select("id, status, provider_id, voided_at")
    .eq("id", parsed.data.batch_id)
    .maybeSingle();
  if (!batch || batch.voided_at) return { ok: false, error: "Batch not found or voided." };
  if (batch.status !== "draft") return { ok: false, error: "Only draft batches accept new items." };

  const { data: trs, error: trErr } = await admin
    .from("test_requests")
    .select("id, hmo_approved_amount_php, status, visits!inner(hmo_provider_id)")
    .in("id", parsed.data.test_request_ids);
  if (trErr) return { ok: false, error: translatePgError(trErr) };
  if (!trs || trs.length !== parsed.data.test_request_ids.length) {
    return { ok: false, error: "Test requests not found." };
  }
  for (const tr of trs) {
    if (tr.status !== "released") return { ok: false, error: "All items must be released." };
    if (
      (tr as unknown as { visits: { hmo_provider_id: string | null } }).visits.hmo_provider_id !==
      batch.provider_id
    ) {
      return { ok: false, error: "All items must belong to the batch's provider." };
    }
  }

  const rows = trs.map((tr) => ({
    batch_id: parsed.data.batch_id,
    test_request_id: tr.id,
    billed_amount_php: tr.hmo_approved_amount_php as number,
  }));
  const { error: iErr } = await admin.from("hmo_claim_items").insert(rows);
  if (iErr) return { ok: false, error: translatePgError(iErr) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.items_added",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: {
      item_count: rows.length,
      total_billed_php: rows.reduce((a, r) => a + Number(r.billed_amount_php), 0),
    },
    ...meta,
  });

  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true };
}

export async function removeItemFromBatchAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = RemoveItemFromBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: item } = await admin
    .from("hmo_claim_items")
    .select("id, batch_id, hmo_claim_batches!inner(status, voided_at)")
    .eq("id", parsed.data.item_id)
    .maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };
  const batchInfo = (
    item as unknown as { hmo_claim_batches: { status: string; voided_at: string | null } }
  ).hmo_claim_batches;
  if (batchInfo.voided_at) return { ok: false, error: "Batch is voided." };
  if (batchInfo.status !== "draft") {
    return { ok: false, error: "Only draft batches allow item removal." };
  }

  const { error: dErr } = await admin
    .from("hmo_claim_items")
    .delete()
    .eq("id", parsed.data.item_id);
  if (dErr) return { ok: false, error: translatePgError(dErr) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.item_removed",
    resource_type: "hmo_claim_item",
    resource_id: parsed.data.item_id,
    metadata: { batch_id: item.batch_id },
    ...meta,
  });

  revalidatePath(`${BASE_PATH}/batches/${item.batch_id}`);
  return { ok: true };
}

export async function submitBatchAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = SubmitBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: batch } = await admin
    .from("hmo_claim_batches")
    .select("id, status, voided_at")
    .eq("id", parsed.data.batch_id)
    .maybeSingle();
  if (!batch || batch.voided_at) return { ok: false, error: "Batch not found." };
  if (batch.status !== "draft") return { ok: false, error: "Only draft batches can be submitted." };

  const { count } = await admin
    .from("hmo_claim_items")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", parsed.data.batch_id);
  if (!count || count < 1) return { ok: false, error: "Batch has no items." };

  const { error } = await admin
    .from("hmo_claim_batches")
    .update({
      status: "submitted",
      submitted_at: parsed.data.submitted_at,
      submitted_by: session.user_id,
      medium: parsed.data.medium,
      reference_no: parsed.data.reference_no ?? null,
    })
    .eq("id", parsed.data.batch_id);
  if (error) return { ok: false, error: translatePgError(error) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.submitted",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: {
      submitted_at: parsed.data.submitted_at,
      medium: parsed.data.medium,
      item_count: count,
    },
    ...meta,
  });
  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true };
}

export async function acknowledgeBatchAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = AcknowledgeBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: batch } = await admin
    .from("hmo_claim_batches")
    .select("status, voided_at")
    .eq("id", parsed.data.batch_id)
    .maybeSingle();
  if (!batch || batch.voided_at) return { ok: false, error: "Batch not found." };
  if (batch.status !== "submitted") {
    return { ok: false, error: "Only submitted batches can be acknowledged." };
  }

  const { error } = await admin
    .from("hmo_claim_batches")
    .update({ status: "acknowledged", hmo_ack_ref: parsed.data.hmo_ack_ref ?? null })
    .eq("id", parsed.data.batch_id);
  if (error) return { ok: false, error: translatePgError(error) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.acknowledged",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: { hmo_ack_ref: parsed.data.hmo_ack_ref ?? null },
    ...meta,
  });
  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true };
}

export async function voidBatchAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = VoidBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { error } = await admin
    .from("hmo_claim_batches")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.void_reason,
      status: "voided",
    })
    .eq("id", parsed.data.batch_id)
    .is("voided_at", null); // idempotency
  if (error) return { ok: false, error: translatePgError(error) }; // P0010 lands here

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.voided",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: { void_reason: parsed.data.void_reason },
    ...meta,
  });
  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  revalidatePath(BASE_PATH);
  return { ok: true };
}

// ============================================================
// Item HMO response
// ============================================================

export async function updateItemHmoResponseAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = UpdateItemHmoResponseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: before } = await admin
    .from("hmo_claim_items")
    .select("id, batch_id, hmo_response, hmo_response_date, hmo_response_notes")
    .eq("id", parsed.data.item_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Item not found." };

  const { error } = await admin
    .from("hmo_claim_items")
    .update({
      hmo_response: parsed.data.hmo_response,
      hmo_response_date: parsed.data.hmo_response_date,
      hmo_response_notes: parsed.data.hmo_response_notes ?? null,
    })
    .eq("id", parsed.data.item_id);
  if (error) return { ok: false, error: translatePgError(error) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_item.hmo_response_updated",
    resource_type: "hmo_claim_item",
    resource_id: parsed.data.item_id,
    metadata: { before, after: parsed.data },
    ...meta,
  });

  revalidatePath(`${BASE_PATH}/batches/${before.batch_id}`);
  return { ok: true };
}

export async function bulkSetHmoResponseAction(
  input: unknown,
): Promise<ActionResult<{ items_updated: number; items_skipped: number }>> {
  const session = await requireAdminStaff();
  const parsed = BulkSetHmoResponseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { count: totalItems } = await admin
    .from("hmo_claim_items")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", parsed.data.batch_id);
  const totalCount = totalItems ?? 0;

  let query = admin
    .from("hmo_claim_items")
    .update({
      hmo_response: parsed.data.response,
      hmo_response_date: parsed.data.response_date,
      hmo_response_notes: parsed.data.notes ?? null,
    })
    .eq("batch_id", parsed.data.batch_id);
  if (parsed.data.scope === "pending_only") {
    query = query.eq("hmo_response", "pending");
  }

  const { data: updatedRows, error } = await query.select("id");
  if (error) return { ok: false, error: translatePgError(error) };

  const items_updated = updatedRows?.length ?? 0;
  const items_skipped = totalCount - items_updated;

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_batch.bulk_hmo_response_set",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: {
      response: parsed.data.response,
      response_date: parsed.data.response_date,
      scope: parsed.data.scope,
      items_updated,
      items_skipped,
    },
    ...meta,
  });

  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true, data: { items_updated, items_skipped } };
}

// ============================================================
// Resolutions
// ============================================================

export async function createResolutionAction(
  input: unknown,
): Promise<ActionResult<{ resolution_id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateResolutionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: row, error } = await admin
    .from("hmo_claim_resolutions")
    .insert({
      item_id: parsed.data.item_id,
      destination: parsed.data.destination,
      amount_php: parsed.data.amount_php,
      resolved_by: session.user_id,
      notes: parsed.data.notes ?? null,
    })
    .select("id")
    .single();
  if (error || !row) {
    return { ok: false, error: translatePgError(error ?? { message: "insert failed" }) };
  }
  // P0011 fires here if overshoot.

  // Fetch batch_id for revalidate.
  const { data: item } = await admin
    .from("hmo_claim_items")
    .select("batch_id")
    .eq("id", parsed.data.item_id)
    .maybeSingle();

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_resolution.created",
    resource_type: "hmo_claim_resolution",
    resource_id: row.id,
    metadata: {
      item_id: parsed.data.item_id,
      destination: parsed.data.destination,
      amount_php: parsed.data.amount_php,
    },
    ...meta,
  });

  if (item?.batch_id) revalidatePath(`${BASE_PATH}/batches/${item.batch_id}`);
  return { ok: true, data: { resolution_id: row.id } };
}

export async function voidResolutionAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = VoidResolutionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: row, error } = await admin
    .from("hmo_claim_resolutions")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.void_reason,
    })
    .eq("id", parsed.data.resolution_id)
    .is("voided_at", null)
    .select("item_id")
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!row) return { ok: false, error: "Resolution not found or already voided." };

  const { data: item } = await admin
    .from("hmo_claim_items")
    .select("batch_id")
    .eq("id", row.item_id)
    .maybeSingle();

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_claim_resolution.voided",
    resource_type: "hmo_claim_resolution",
    resource_id: parsed.data.resolution_id,
    metadata: { void_reason: parsed.data.void_reason },
    ...meta,
  });

  if (item?.batch_id) revalidatePath(`${BASE_PATH}/batches/${item.batch_id}`);
  return { ok: true };
}

// ============================================================
// Settlement + allocation
// ============================================================

export async function recordHmoSettlementAction(
  input: unknown,
): Promise<ActionResult<{ payment_ids: string[]; allocation_count: number }>> {
  const session = await requireAdminStaff();
  const parsed = RecordHmoSettlementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  // Load items + their visit_ids.
  const itemIds = parsed.data.items.map((it) => it.item_id);
  const { data: items, error: iErr } = await admin
    .from("hmo_claim_items")
    .select(
      "id, batch_id, billed_amount_php, paid_amount_php, test_request_id, test_requests!inner(visit_id)",
    )
    .in("id", itemIds);
  if (iErr) return { ok: false, error: translatePgError(iErr) };
  if (!items || items.length !== itemIds.length) {
    return { ok: false, error: "Some items not found." };
  }
  // Verify all items belong to the input batch_id (single-batch settlement rule).
  for (const it of items) {
    if (it.batch_id !== parsed.data.batch_id) {
      return { ok: false, error: "All items must belong to batch_id." };
    }
  }

  // Group amounts by visit_id.
  const visitTotals = new Map<string, number>();
  const itemAmount = new Map<string, number>(
    parsed.data.items.map((i) => [i.item_id, i.amount_php]),
  );
  const itemVisit = new Map<string, string>();
  for (const it of items) {
    const visitId = (it as unknown as { test_requests: { visit_id: string } }).test_requests
      .visit_id;
    itemVisit.set(it.id, visitId);
    visitTotals.set(visitId, (visitTotals.get(visitId) ?? 0) + (itemAmount.get(it.id) ?? 0));
  }

  // Insert one payments row per visit.
  // NOTE: payments table uses `reference_number` and `received_by` (not `reference` / `recorded_by`).
  const paymentIds: string[] = [];
  const visitPaymentIds = new Map<string, string>();
  for (const [visitId, amount] of visitTotals.entries()) {
    const { data: p, error: pErr } = await admin
      .from("payments")
      .insert({
        visit_id: visitId,
        amount_php: amount,
        method: "hmo",
        reference_number: parsed.data.bank_reference ?? null,
        received_at: parsed.data.payment_date,
        received_by: session.user_id,
      })
      .select("id")
      .single();
    if (pErr || !p) {
      // Best-effort rollback of payments already inserted.
      for (const id of paymentIds) {
        await admin.from("payments").delete().eq("id", id);
      }
      return {
        ok: false,
        error: translatePgError(pErr ?? { message: "payment insert failed" }),
      };
    }
    paymentIds.push(p.id);
    visitPaymentIds.set(visitId, p.id);
  }

  // Insert allocations.
  const allocRows = parsed.data.items.map((it) => ({
    payment_id: visitPaymentIds.get(itemVisit.get(it.item_id)!)!,
    item_id: it.item_id,
    amount_php: it.amount_php,
  }));
  const { error: aErr } = await admin.from("hmo_payment_allocations").insert(allocRows);
  if (aErr) {
    for (const id of paymentIds) {
      await admin.from("payments").delete().eq("id", id);
    }
    return { ok: false, error: translatePgError(aErr) };
  }

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_settlement.recorded",
    resource_type: "hmo_claim_batch",
    resource_id: parsed.data.batch_id,
    metadata: {
      total_amount_php: parsed.data.total_amount_php,
      payment_count: paymentIds.length,
      allocation_count: allocRows.length,
      payment_ids: paymentIds,
      bank_reference: parsed.data.bank_reference ?? null,
    },
    ...meta,
  });

  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true, data: { payment_ids: paymentIds, allocation_count: allocRows.length } };
}

export async function allocateExistingPaymentAction(input: unknown): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = AllocateExistingPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();

  const { data: payment } = await admin
    .from("payments")
    .select("id, amount_php, method, voided_at, visit_id")
    .eq("id", parsed.data.payment_id)
    .maybeSingle();
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.voided_at) return { ok: false, error: "Payment is voided." };
  if (payment.method !== "hmo") return { ok: false, error: "Only HMO payments can be allocated." };

  const sum = parsed.data.allocations.reduce((a, r) => a + r.amount_php, 0);
  if (Math.abs(sum - Number(payment.amount_php)) > 0.005) {
    return {
      ok: false,
      error: `Allocation sum (₱${sum}) must equal payment amount (₱${payment.amount_php}).`,
    };
  }

  // Validate all items belong to the payment's visit (per the per-visit payment model).
  const itemIds = parsed.data.allocations.map((a) => a.item_id);
  const { data: items, error: iErr } = await admin
    .from("hmo_claim_items")
    .select("id, test_requests!inner(visit_id)")
    .in("id", itemIds);
  if (iErr) return { ok: false, error: translatePgError(iErr) };
  if (!items || items.length !== itemIds.length) return { ok: false, error: "Items not found." };
  for (const it of items) {
    const visitId = (it as unknown as { test_requests: { visit_id: string } }).test_requests
      .visit_id;
    if (visitId !== payment.visit_id) {
      return { ok: false, error: "All allocated items must belong to the payment's visit." };
    }
  }

  const rows = parsed.data.allocations.map((a) => ({
    payment_id: parsed.data.payment_id,
    item_id: a.item_id,
    amount_php: a.amount_php,
  }));
  const { error } = await admin.from("hmo_payment_allocations").insert(rows);
  if (error) return { ok: false, error: translatePgError(error) };
  // P0012 fires here on overshoot.

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_payment_allocations.created",
    resource_type: "payment",
    resource_id: parsed.data.payment_id,
    metadata: {
      allocation_count: rows.length,
      total_amount_php: sum,
    },
    ...meta,
  });

  revalidatePath(`/staff/visits/${payment.visit_id}`);
  return { ok: true };
}
