import "server-only";

// The bodies of the lab queue's bulk claim / unclaim for SINGLE tests (the
// delete half lives in bulk-delete-core.ts, which classifies differently in
// query-surfaces.test.ts).
// Plain server-only module — NOT "use server" — so the batch id can be an
// argument. Every export of a "use server" file is a public endpoint the
// browser can call with arbitrary input; a batch id that came from there could
// be forged to fold unrelated audit rows into someone's Undo. So the entry
// points (claimTestsAction, unclaimTestsAction, deleteTestRequestsManyAction,
// and queue/panel-actions.ts) parse the input, check the role, MINT the id
// with crypto.randomUUID() and hand it to a core here as a BulkBatchContext.
//
// Each core re-checks the role itself: a direct call can't skip the refusal.

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit/log";
import type { createClient } from "@/lib/supabase/server";
import type { StaffSession } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { evaluateClaim, evaluateUnclaim } from "@/lib/queue/claim-eligibility";
import { isDoctorKind } from "@/lib/visits/order-lines";
import type { BulkQueueResult, SkippedRow } from "@/lib/queue/bulk-queue";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** One bulk call's identity — minted server-side by the entry point, never read from input. */
export interface BulkBatchContext {
  batchId: string;
  /** rows in the whole selection (singles + panels), for audit only */
  batchSize: number;
}

// Roles that can hold a lab claim — reassignment targets must be one of these.
export const LAB_CAPABLE_ROLES = ["medtech", "xray_technician", "pathologist", "admin"] as const;

export const NOT_LAB_STAFF = "Only lab staff can claim or unclaim tests from the queue.";
export const BULK_INPUT_ERROR = "Could not read the selection — refresh the queue and try again.";

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export async function claimTestsCore(
  session: StaffSession,
  supabase: Supabase,
  testIds: string[],
  ctx: BulkBatchContext,
): Promise<BulkQueueResult> {
  // Role before anything candidate-dependent (spec §9 item 5).
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const ids = Array.from(new Set(testIds));
  const { ip, ua } = await ipAndAgent();

  const { data: rows, error: readError } = await supabase
    .from("test_requests")
    .select(
      "id, is_package_header, services!inner ( kind, section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("id", ids)
    // A queue-deleted line (0125) reads as not found.
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const changed: Array<{ id: string; visit_id: string }> = [];
  const skipped: SkippedRow[] = [];
  const startedAt = new Date().toISOString();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue or no longer exists." });
      continue;
    }
    const verdict = evaluateClaim(
      {
        isPackageHeader: row.is_package_header,
        isDoctorLine: isDoctorKind(row.services.kind),
        section: row.services.section,
        visitDeleted: row.visits.deleted_at !== null,
        visit: row.visits,
      },
      session.role,
    );
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    // The state the operator saw: requested, nobody holding it.
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
      .eq("id", id)
      .eq("status", "requested")
      .is("assigned_to", null)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Claimed by someone else or changed just now." });
    } else {
      changed.push(data);
    }
  }

  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: row.visit_id,
        bulk_batch_size: ctx.batchSize,
        bulk_batch_id: ctx.batchId,
        started_at: startedAt,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped, batchId: ctx.batchId };
}

// ---------------------------------------------------------------------------
// Unclaim
// ---------------------------------------------------------------------------

export async function unclaimTestsCore(
  session: StaffSession,
  supabase: Supabase,
  input: {
    items: ReadonlyArray<{ testRequestId: string; assignedTo: string }>;
    reason?: string;
  },
  ctx: BulkBatchContext,
): Promise<BulkQueueResult> {
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  // First occurrence of an id wins.
  const seenHolder = new Map<string, string>();
  for (const item of input.items) {
    if (!seenHolder.has(item.testRequestId)) seenHolder.set(item.testRequestId, item.assignedTo);
  }
  const ids = [...seenHolder.keys()];
  const reason = input.reason?.trim() || null;
  // Same power as the row's Unclaim: admin anyone's, everyone else their own.
  const ownerId = session.role === "admin" ? null : session.user_id;

  const { ip, ua } = await ipAndAgent();

  const { data: before, error: readError } = await supabase
    .from("test_requests")
    .select("id, assigned_to, status, started_at, visits!inner ( id )")
    .in("id", ids)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((before ?? []).map((r) => [r.id, r]));

  const changed: Array<{
    id: string;
    visit_id: string;
    previous: string;
    previousStartedAt: string | null;
  }> = [];
  const skipped: SkippedRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const saw = seenHolder.get(id)!;
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue — restore it before unclaiming it." });
      continue;
    }
    const verdict = evaluateUnclaim(row, ownerId);
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    if (row.assigned_to !== saw) {
      skipped.push({ id, reason: "Someone else holds this test now — refresh the queue." });
      continue;
    }
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "requested", assigned_to: null, started_at: null })
      .eq("id", id)
      .eq("status", "in_progress")
      .eq("assigned_to", saw)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Changed just now — refresh the queue." });
    } else {
      changed.push({
        id: data.id,
        visit_id: data.visit_id,
        previous: saw,
        previousStartedAt: row.started_at,
      });
    }
  }

  // Same audit shape as performUnclaim, so the queue's Remarks column
  // (queue_claim_remarks, 0160) reads bulk unclaims unchanged.
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.unclaimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: row.visit_id,
        previous_assignee: row.previous,
        previous_started_at: row.previousStartedAt,
        reason,
        self_service: ownerId !== null,
        bulk_batch_size: ctx.batchSize,
        bulk_batch_id: ctx.batchId,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped, batchId: ctx.batchId };
}
