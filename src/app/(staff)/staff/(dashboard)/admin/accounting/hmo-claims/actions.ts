"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
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
  // services.kind required so we can enforce single-kind batches (lab vs doctor).
  const { data: trs, error: trErr } = await admin
    .from("test_requests")
    .select("id, visit_id, hmo_approved_amount_php, status, visits!inner(hmo_provider_id), services!inner(kind)")
    .in("id", parsed.data.test_request_ids);
  if (trErr) return { ok: false, error: translatePgError(trErr) };
  if (!trs || trs.length !== parsed.data.test_request_ids.length) {
    return { ok: false, error: "One or more test requests not found." };
  }
  const kinds = new Set<"lab" | "doctor">();
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
    const serviceKind = (tr as unknown as { services: { kind: string } }).services.kind;
    kinds.add(["doctor_consultation", "doctor_procedure"].includes(serviceKind) ? "doctor" : "lab");
  }
  if (kinds.size > 1) {
    return { ok: false, error: "All items in a batch must be the same kind (lab tests OR doctor consults, not mixed)." };
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
    .select("id, hmo_approved_amount_php, status, visits!inner(hmo_provider_id), services!inner(kind)")
    .in("id", parsed.data.test_request_ids);
  if (trErr) return { ok: false, error: translatePgError(trErr) };
  if (!trs || trs.length !== parsed.data.test_request_ids.length) {
    return { ok: false, error: "Test requests not found." };
  }
  const kinds = new Set<"lab" | "doctor">();
  for (const tr of trs) {
    if (tr.status !== "released") return { ok: false, error: "All items must be released." };
    if (
      (tr as unknown as { visits: { hmo_provider_id: string | null } }).visits.hmo_provider_id !==
      batch.provider_id
    ) {
      return { ok: false, error: "All items must belong to the batch's provider." };
    }
    const serviceKind = (tr as unknown as { services: { kind: string } }).services.kind;
    kinds.add(["doctor_consultation", "doctor_procedure"].includes(serviceKind) ? "doctor" : "lab");
  }
  if (kinds.size > 1) {
    return { ok: false, error: "All items in a batch must be the same kind (lab tests OR doctor consults, not mixed)." };
  }
  // Match the existing batch's kind: look at one existing item.
  const { data: existingItem } = await admin
    .from("hmo_claim_items")
    .select("test_request_id, test_requests!inner(services!inner(kind))")
    .eq("batch_id", parsed.data.batch_id)
    .limit(1)
    .maybeSingle();
  if (existingItem) {
    const existingKindRaw = (existingItem as unknown as { test_requests: { services: { kind: string } } })
      .test_requests.services.kind;
    const existingKind = ["doctor_consultation", "doctor_procedure"].includes(existingKindRaw)
      ? "doctor"
      : "lab";
    if (!kinds.has(existingKind)) {
      return { ok: false, error: `Existing batch contains ${existingKind} items; new items must be the same kind.` };
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

  const { data: updated, error } = await admin
    .from("hmo_claim_batches")
    .update({
      status: "submitted",
      submitted_at: parsed.data.submitted_at,
      submitted_by: session.user_id,
      medium: parsed.data.medium,
      reference_no: parsed.data.reference_no ?? null,
    })
    .eq("id", parsed.data.batch_id)
    .eq("status", "draft") // concurrency guard — second submitter sees no row
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated) {
    return { ok: false, error: "Batch is no longer in draft (likely already submitted)." };
  }

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

  const { data: updated, error } = await admin
    .from("hmo_claim_batches")
    .update({ status: "acknowledged", hmo_ack_ref: parsed.data.hmo_ack_ref ?? null })
    .eq("id", parsed.data.batch_id)
    .eq("status", "submitted") // concurrency guard
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated) {
    return {
      ok: false,
      error: "Batch is no longer in submitted state (likely already acknowledged).",
    };
  }

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

// NOTE: Settlement is N+1 INSERTs (one payment per visit + N allocations) without a
// true transaction. Best-effort rollback below deletes any payments inserted before a
// later failure (the bridge's bridge_payment_delete trigger reverses their JEs). If
// rollback itself fails (network partition mid-cleanup), orphan payments may persist
// — they'd remain visible in the audit log and on the visit. For full atomicity,
// future work can move this into a Postgres function (see 12.3 spec §17 "Estimated
// effort" notes and the plan's Task 18 NOTE).
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

// ============================================================
// 12.B — Mark historic HMO claims as billed
// ============================================================

const MarkHistoricBilledSchema = z.object({
  claim_ids: z.array(z.string().uuid()).min(1).max(500),
  date_submitted: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  billed_by_staff_id: z.string().uuid(),
});

export async function markHistoricClaimsBilledAction(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = MarkHistoricBilledSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  // Verify the staff_profiles row exists + is active.
  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, full_name, is_active")
    .eq("id", parsed.data.billed_by_staff_id)
    .maybeSingle();
  if (!staff || !staff.is_active) {
    return { ok: false, error: "Selected staff member is not active." };
  }

  const recordedAt = new Date().toISOString();

  const { data: updated, error } = await admin
    .from("historic_hmo_claims" as never)
    .update({
      date_submitted: parsed.data.date_submitted,
      billed_by_staff_id: parsed.data.billed_by_staff_id,
      billed_recorded_at: recordedAt,
    } as never)
    .in("id", parsed.data.claim_ids)
    .is("date_submitted", null)
    .select("id");

  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  const updatedCount = Array.isArray(updated) ? updated.length : 0;
  if (updatedCount === 0) {
    return {
      ok: false,
      error: "No rows updated — possibly all selected claims were already marked billed.",
    };
  }

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "historic_hmo.marked_billed",
    resource_type: "historic_hmo_claim",
    resource_id: parsed.data.claim_ids[0],
    metadata: {
      claim_count: updatedCount,
      date_submitted: parsed.data.date_submitted,
      billed_by_staff_id: parsed.data.billed_by_staff_id,
      billed_by_name: staff.full_name,
      claim_ids: parsed.data.claim_ids,
    },
    ...meta,
  });

  revalidatePath(BASE_PATH);
  return { ok: true, data: { updated: updatedCount } };
}

// ----------------------------------------------------------------
// Unmark historic claim (reverse of markBilled)
// ----------------------------------------------------------------

const UnmarkHistoricBilledSchema = z.object({
  claim_ids: z.array(z.string().uuid()).min(1).max(500),
});

export async function unmarkHistoricClaimsBilledAction(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = UnmarkHistoricBilledSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("historic_hmo_claims" as never)
    .update({
      date_submitted: null,
      billed_by_staff_id: null,
      billed_recorded_at: null,
    } as never)
    .in("id", parsed.data.claim_ids)
    .not("date_submitted", "is", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  const updatedCount = Array.isArray(updated) ? updated.length : 0;
  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "historic_hmo.unmarked_billed",
    resource_type: "historic_hmo_claim",
    resource_id: parsed.data.claim_ids[0],
    metadata: { claim_count: updatedCount, claim_ids: parsed.data.claim_ids },
    ...meta,
  });
  revalidatePath(BASE_PATH);
  return { ok: true, data: { updated: updatedCount } };
}

// ----------------------------------------------------------------
// Mark historic claims as PAID + post settlement JE per claim
// ----------------------------------------------------------------

const MarkHistoricPaidSchema = z.object({
  claim_ids: z.array(z.string().uuid()).min(1).max(500),
  date_paid: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date paid."),
  // CoA code of the cash/bank account that received the settlement.
  // The list of valid codes is admin-managed via chart_of_accounts.is_settlement_destination.
  payment_method: z.string().min(1).max(20),
  or_number: z.string().max(50).optional().nullable(),
  paid_recorded_by_staff_id: z.string().uuid(),
});

export async function markHistoricClaimsPaidAction(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = MarkHistoricPaidSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, full_name, is_active")
    .eq("id", parsed.data.paid_recorded_by_staff_id)
    .maybeSingle();
  if (!staff || !staff.is_active) {
    return { ok: false, error: "Selected staff member is not active." };
  }

  // Validate the payment method against settlement-destination accounts.
  const { data: accts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, is_settlement_destination, is_active");
  const codeToAcct = new Map(
    (accts ?? []).map((a) => [a.code, a]),
  );
  const drAcct = codeToAcct.get(parsed.data.payment_method);
  if (!drAcct) {
    return { ok: false, error: `Payment method code "${parsed.data.payment_method}" not found in Chart of Accounts.` };
  }
  if (!drAcct.is_active) {
    return { ok: false, error: `Payment method "${drAcct.name}" is inactive.` };
  }
  if (!drAcct.is_settlement_destination) {
    return { ok: false, error: `Account ${drAcct.code} ${drAcct.name} is not enabled as a payment method. Toggle it on in Chart of Accounts.` };
  }
  const drCashId = drAcct.id;
  const crArHmoId = codeToAcct.get("1110")?.id;
  if (!crArHmoId) {
    return { ok: false, error: "CoA mapping missing for 1110 AR-HMO." };
  }

  // Fetch the claims so we know amounts + provider info for the JEs.
  type ClaimRow = {
    id: string;
    final_amount_php: number;
    status: string;
    hmo_provider: string;
    patient_name: string;
    service_description: string | null;
  };
  const { data: claims, error: claimsErr } = await admin
    .from("historic_hmo_claims" as never)
    .select("id, final_amount_php, status, hmo_provider, patient_name, service_description")
    .in("id", parsed.data.claim_ids)
    .returns<ClaimRow[]>();
  if (claimsErr || !claims) {
    return { ok: false, error: translatePgError(claimsErr ?? { message: "fetch failed" }) };
  }
  const eligible = claims.filter((c) => c.status === "pending" || c.status === "overdue");
  if (eligible.length === 0) {
    return { ok: false, error: "No eligible claims (must be pending or overdue)." };
  }

  const runStamp = new Date().toISOString();
  let posted = 0, failed = 0;
  for (const c of eligible) {
    const fy = Number(parsed.data.date_paid.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { failed++; continue; }

    const amt = Math.round(Number(c.final_amount_php) * 100) / 100;
    const desc = `[history] HMO settlement: ${c.hmo_provider} / ${c.patient_name}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx HMO SETTLEMENT claim_id=${c.id} | service=${c.service_description ?? "?"} | method=${parsed.data.payment_method}${parsed.data.or_number ? ` | OR=${parsed.data.or_number}` : ""}`.slice(0, 2000);

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: parsed.data.date_paid,
        description: desc,
        notes,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { failed++; continue; }

    const lineDesc = `Settle HMO ${c.hmo_provider}: ${c.patient_name}`.slice(0, 500);
    const { error: lErr } = await admin.from("journal_lines").insert([
      { entry_id: je.id, account_id: drCashId, debit_php: amt, credit_php: 0, description: lineDesc, line_order: 1 },
      { entry_id: je.id, account_id: crArHmoId, debit_php: 0, credit_php: amt, description: lineDesc, line_order: 2 },
    ]);
    if (lErr) {
      await admin.from("journal_entries").delete().eq("id", je.id);
      failed++; continue;
    }
    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { failed++; continue; }

    const { error: updErr } = await admin
      .from("historic_hmo_claims" as never)
      .update({
        status: "paid",
        date_paid: parsed.data.date_paid,
        or_number: parsed.data.or_number ?? null,
        paid_payment_method: parsed.data.payment_method,
        paid_recorded_by_staff_id: parsed.data.paid_recorded_by_staff_id,
        paid_recorded_at: runStamp,
        journal_entry_id: je.id,
      } as never)
      .eq("id", c.id);
    if (updErr) { failed++; continue; }
    posted++;
  }

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "historic_hmo.marked_paid",
    resource_type: "historic_hmo_claim",
    resource_id: eligible[0]?.id ?? null,
    metadata: {
      claim_count: posted,
      failed,
      date_paid: parsed.data.date_paid,
      payment_method: parsed.data.payment_method,
      paid_by_name: staff.full_name,
      claim_ids: parsed.data.claim_ids,
    },
    ...meta,
  });

  revalidatePath(BASE_PATH);
  return { ok: true, data: { updated: posted } };
}

// ----------------------------------------------------------------
// Write off historic claims (DR 6920 Bad Debt / CR 1110 AR-HMO)
// ----------------------------------------------------------------

const WriteOffHistoricSchema = z.object({
  claim_ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z.string().min(3).max(500),
  wrote_off_by_staff_id: z.string().uuid(),
  write_off_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a write-off posting date."),
});

export async function writeOffHistoricClaimsAction(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = WriteOffHistoricSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, full_name, is_active")
    .eq("id", parsed.data.wrote_off_by_staff_id)
    .maybeSingle();
  if (!staff || !staff.is_active) {
    return { ok: false, error: "Selected staff member is not active." };
  }

  type ClaimRow = {
    id: string;
    final_amount_php: number;
    status: string;
    hmo_provider: string;
    patient_name: string;
    service_description: string | null;
  };
  const { data: claims, error: cErr } = await admin
    .from("historic_hmo_claims" as never)
    .select("id, final_amount_php, status, hmo_provider, patient_name, service_description")
    .in("id", parsed.data.claim_ids)
    .returns<ClaimRow[]>();
  if (cErr || !claims) {
    return { ok: false, error: translatePgError(cErr ?? { message: "fetch failed" }) };
  }
  const eligible = claims.filter((c) => c.status === "pending" || c.status === "overdue");
  if (eligible.length === 0) {
    return { ok: false, error: "No eligible claims (must be pending or overdue)." };
  }

  const { data: accts } = await admin.from("chart_of_accounts").select("id, code");
  const codeToId = new Map((accts ?? []).map((a) => [a.code, a.id]));
  const drBadDebtId = codeToId.get("6920");
  const crArHmoId = codeToId.get("1110");
  if (!drBadDebtId || !crArHmoId) {
    return { ok: false, error: "CoA mapping missing for 6920 / 1110." };
  }

  const runStamp = new Date().toISOString();
  let posted = 0, failed = 0;
  for (const c of eligible) {
    const fy = Number(parsed.data.write_off_date.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { failed++; continue; }

    const amt = Math.round(Number(c.final_amount_php) * 100) / 100;
    const desc = `[history] HMO write-off: ${c.hmo_provider} / ${c.patient_name}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx HMO WRITE-OFF claim_id=${c.id} | reason=${parsed.data.reason}`.slice(0, 2000);

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: parsed.data.write_off_date,
        description: desc,
        notes,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { failed++; continue; }

    const lineDesc = `Write off ${c.hmo_provider}: ${c.patient_name}`.slice(0, 500);
    const { error: lErr } = await admin.from("journal_lines").insert([
      { entry_id: je.id, account_id: drBadDebtId, debit_php: amt, credit_php: 0, description: lineDesc, line_order: 1 },
      { entry_id: je.id, account_id: crArHmoId, debit_php: 0, credit_php: amt, description: lineDesc, line_order: 2 },
    ]);
    if (lErr) {
      await admin.from("journal_entries").delete().eq("id", je.id);
      failed++; continue;
    }
    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { failed++; continue; }

    const { error: updErr } = await admin
      .from("historic_hmo_claims" as never)
      .update({
        status: "written_off",
        wrote_off_by_staff_id: parsed.data.wrote_off_by_staff_id,
        wrote_off_at: runStamp,
        wrote_off_journal_entry_id: je.id,
        write_off_reason: parsed.data.reason,
      } as never)
      .eq("id", c.id);
    if (updErr) { failed++; continue; }
    posted++;
  }

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "historic_hmo.written_off",
    resource_type: "historic_hmo_claim",
    resource_id: eligible[0]?.id ?? null,
    metadata: {
      claim_count: posted,
      failed,
      reason: parsed.data.reason,
      claim_ids: parsed.data.claim_ids,
    },
    ...meta,
  });

  revalidatePath(BASE_PATH);
  return { ok: true, data: { updated: posted } };
}

// ----------------------------------------------------------------
// Aging snapshot (point-in-time roll-up)
// ----------------------------------------------------------------

const AgingSnapshotSchema = z.object({
  snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a snapshot date."),
});

export async function snapshotHmoAgingAction(
  input: unknown,
): Promise<ActionResult<{ rows: number }>> {
  const session = await requireAdminStaff();
  const parsed = AgingSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  type AgingRow = {
    provider_id: string | null;
    provider_name: string | null;
    bucket: string | null;
    kind: string | null;
    total_php: number | null;
    item_count: number | null;
  };
  const { data, error } = await admin
    .from("v_hmo_ar_aging")
    .select("provider_id, provider_name, bucket, kind, total_php, item_count")
    .returns<AgingRow[]>();
  if (error || !data) {
    return { ok: false, error: translatePgError(error ?? { message: "fetch failed" }) };
  }

  const rows = data
    .filter((r) => r.provider_id && r.provider_name && r.bucket && r.kind)
    .map((r) => ({
      snapshot_date: parsed.data.snapshot_date,
      provider_id: r.provider_id!,
      provider_name: r.provider_name!,
      bucket: r.bucket!,
      kind: r.kind!,
      total_php: Number(r.total_php ?? 0),
      item_count: Number(r.item_count ?? 0),
      recorded_by: session.user_id,
    }));

  if (rows.length === 0) {
    return { ok: false, error: "No aging data to snapshot." };
  }

  const { error: insErr, count } = await admin
    .from("hmo_aging_snapshots" as never)
    .upsert(rows as never, {
      onConflict: "snapshot_date,provider_id,bucket,kind",
      ignoreDuplicates: false,
      count: "exact",
    });
  if (insErr) return { ok: false, error: translatePgError(insErr) };

  const meta = await auditMeta();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_aging.snapshot",
    resource_type: "hmo_aging_snapshots",
    resource_id: null,
    metadata: { snapshot_date: parsed.data.snapshot_date, rows: count ?? rows.length },
    ...meta,
  });

  revalidatePath(BASE_PATH);
  return { ok: true, data: { rows: count ?? rows.length } };
}
