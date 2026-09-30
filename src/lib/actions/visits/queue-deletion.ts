"use server";

/**
 * Queue-entry deletion lifecycle (partner revisions item 22, decision 6).
 *
 * Reception + admin soft-delete UNPAID entries — a whole visit from the
 * reception queue, or a standalone test / whole package from the lab queue
 * and visit page — with a required audit-logged reason, and can restore
 * them later. The 0125 triggers are the source of truth for the unpaid-only
 * rule, the package cascade, and the visit-total recalc; role checks here
 * mirror the "test_requests: reception/admin write" RLS policy.
 *
 * Shared by the reception queue, the lab queue, and the visit detail page —
 * same shape as finalise-consolidated living under src/lib/actions.
 */

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { QUEUE_DELETE_ROLES } from "@/lib/visits/deletion";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import type { BulkQueueResult } from "@/lib/queue/bulk-queue";
import {
  deleteTestRequestsForVisit,
  deleteTestRequestsManyCore,
  parseQueueDeleteReason,
} from "@/lib/actions/queue/bulk-cores";
import { revalidateQueueSurfaces, restoreTestRequestsForVisit } from "@/lib/actions/visits/queue-restore-core";

export type QueueDeletionResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

async function requireQueueDeleteStaff() {
  const session = await requireActiveStaff();
  if (!QUEUE_DELETE_ROLES.has(session.role)) {
    return {
      session: null,
      error: "Only reception or admin can delete queue entries.",
    } as const;
  }
  return { session, error: null } as const;
}

// ---------------------------------------------------------------------------
// Visit level (reception queue)
// ---------------------------------------------------------------------------

export async function deleteVisitAction(
  visitId: string,
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = parseQueueDeleteReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const admin = createAdminClient();
  const { data: visit } = await admin
    .from("visits")
    .select(
      "id, visit_number, patient_id, total_php, payment_status, deleted_at, test_requests ( id, deleted_at )",
    )
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) return { ok: false, error: "Visit not found." };
  if (visit.deleted_at) return { ok: false, error: "Visit is already deleted." };

  const { error } = await admin
    .from("visits")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: session.user_id,
      delete_reason: parsed.reason,
    })
    .eq("id", visitId)
    .is("deleted_at", null); // race guard: second concurrent delete is a no-op
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visit.patient_id,
    action: "visit.deleted",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      reason: parsed.reason,
      visit_number: visit.visit_number,
      total_php: Number(visit.total_php),
      active_test_count: (visit.test_requests ?? []).filter(
        (t) => t.deleted_at === null,
      ).length,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateQueueSurfaces(visitId);
  return { ok: true, count: 1 };
}

export async function restoreVisitAction(
  visitId: string,
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  // 0167: a queue restore puts a deleted visit's work back on the board —
  // refuse it on an inactive patient (restore the patient first).
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };
  const parsed = parseQueueDeleteReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const admin = createAdminClient();
  const { data: visit } = await admin
    .from("visits")
    .select("id, visit_number, patient_id, deleted_at, delete_reason")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) return { ok: false, error: "Visit not found." };
  if (!visit.deleted_at) return { ok: false, error: "Visit is not deleted." };

  const { error } = await admin
    .from("visits")
    .update({ deleted_at: null, deleted_by: null, delete_reason: null })
    .eq("id", visitId)
    .not("deleted_at", "is", null);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visit.patient_id,
    action: "visit.restored",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      reason: parsed.reason,
      visit_number: visit.visit_number,
      prior_delete_reason: visit.delete_reason,
      prior_deleted_at: visit.deleted_at,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateQueueSurfaces(visitId);
  return { ok: true, count: 1 };
}

// ---------------------------------------------------------------------------
// Test level (lab queue, visit detail) — bulk-shaped like
// undoReleaseSelectedAction so single-row and consolidated-panel deletes
// share one code path. Package headers cascade to their components in the
// DB trigger; components themselves are rejected there (P0044).
// ---------------------------------------------------------------------------

export async function deleteTestRequestsAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = parseQueueDeleteReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }
  if (testRequestIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      error: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    };
  }
  const outcome = await deleteTestRequestsForVisit(
    session,
    visitId,
    testRequestIds,
    parsed.reason,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, count: outcome.deletedIds.length };
}

const ManyDeleteSchema = z.object({
  testRequestIds: z
    .array(z.string().uuid({ message: "Could not read the selection — refresh the queue and try again." }))
    .min(1, { message: "Nothing to delete — no tests were selected." })
    .max(MAX_BULK_SELECTION, {
      message: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    }),
  reason: z.string(),
});

// The lab queue's bulk Delete (spec §6): a selection that can span visits —
// never trusted from the page. Order matters — role, then the input's shape
// and the reason, and only then the service-role reads — so an empty or
// unknown-id batch from a caller without the role gets the role error, never
// a candidate-dependent message. The body lives in bulk-cores.ts
// (deleteTestRequestsManyCore), which re-checks the role and the reason. This
// public entry point mints its own batch id: the browser must never supply
// one. panel-actions.ts calls the core directly, sharing one id.
export async function deleteTestRequestsManyAction(input: unknown): Promise<BulkQueueResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const shape = ManyDeleteSchema.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      error:
        shape.error.issues[0]?.message ??
        "Could not read the selection — refresh the queue and try again.",
    };
  }
  const batchId = crypto.randomUUID();
  const ids = Array.from(new Set(shape.data.testRequestIds));
  return deleteTestRequestsManyCore(
    session,
    { testRequestIds: ids, reason: shape.data.reason },
    { batchId, batchSize: ids.length },
  );
}

export async function restoreTestRequestsAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = parseQueueDeleteReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }
  if (testRequestIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      error: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    };
  }

  const outcome = await restoreTestRequestsForVisit(session, visitId, testRequestIds, parsed.reason);
  if (!outcome.ok) return outcome;
  return { ok: true, count: outcome.restoredIds.length };
}
