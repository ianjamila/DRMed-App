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

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { QueueDeleteReasonSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { QUEUE_DELETE_ROLES } from "@/lib/visits/deletion";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";

export type QueueDeletionResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

// Every surface that renders visits or queue rows and must drop (or show)
// deleted entries immediately.
function revalidateQueueSurfaces(visitId: string) {
  revalidatePath("/staff/visits/queue");
  revalidatePath("/staff/queue");
  revalidatePath("/staff/visits");
  revalidatePath("/staff/results");
  revalidatePath(`/staff/visits/${visitId}`);
}

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

function parseReason(reason: string):
  | { ok: true; reason: string }
  | { ok: false; error: string } {
  const parsed = QueueDeleteReasonSchema.safeParse({ reason });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Reason is required.",
    };
  }
  return { ok: true, reason: parsed.data.reason };
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
  const parsed = parseReason(reason);
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
  const parsed = parseReason(reason);
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
  const parsed = parseReason(reason);
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

  const admin = createAdminClient();
  const { data: candidates } = await admin
    .from("test_requests")
    .select(
      "id, final_price_php, is_package_header, visits!inner ( patient_id, deleted_at ), services ( name, code )",
    )
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .is("deleted_at", null);
  const rows = candidates ?? [];
  if (rows.length === 0) {
    return { ok: false, error: "None of the selected tests can be deleted." };
  }
  if (rows.some((r) => r.visits.deleted_at !== null)) {
    return { ok: false, error: "Visit is already deleted." };
  }

  // One UPDATE per action call — the 0125 guard raises P0042/P0043/P0044 for
  // the whole statement, so a mixed selection fails atomically rather than
  // half-deleting.
  const { data: deleted, error } = await admin
    .from("test_requests")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: session.user_id,
      delete_reason: parsed.reason,
    })
    .in(
      "id",
      rows.map((r) => r.id),
    )
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "None of the selected tests can be deleted." };
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const { ip, ua } = await ipAndAgent();
  for (const row of deleted) {
    const info = rowById.get(row.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: info?.visits.patient_id ?? null,
      action: "test_request.deleted",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        reason: parsed.reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        final_price_php:
          info?.final_price_php != null ? Number(info.final_price_php) : null,
        is_package_header: info?.is_package_header ?? false,
        bulk: deleted.length > 1,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidateQueueSurfaces(visitId);
  return { ok: true, count: deleted.length };
}

export async function restoreTestRequestsAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = parseReason(reason);
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

  const admin = createAdminClient();
  const { data: candidates } = await admin
    .from("test_requests")
    .select(
      "id, deleted_at, delete_reason, parent_id, visits!inner ( patient_id, deleted_at ), services ( name, code )",
    )
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .not("deleted_at", "is", null)
    // Components ride their header's cascade on restore, exactly like delete.
    .is("parent_id", null);
  const rows = candidates ?? [];
  if (rows.length === 0) {
    return { ok: false, error: "None of the selected tests can be restored." };
  }
  if (rows.some((r) => r.visits.deleted_at !== null)) {
    return {
      ok: false,
      error: "The visit itself is deleted — restore the visit first.",
    };
  }

  const { data: restored, error } = await admin
    .from("test_requests")
    .update({ deleted_at: null, deleted_by: null, delete_reason: null })
    .in(
      "id",
      rows.map((r) => r.id),
    )
    .eq("visit_id", visitId)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!restored || restored.length === 0) {
    return { ok: false, error: "None of the selected tests can be restored." };
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const { ip, ua } = await ipAndAgent();
  for (const row of restored) {
    const info = rowById.get(row.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: info?.visits.patient_id ?? null,
      action: "test_request.restored",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        reason: parsed.reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        prior_delete_reason: info?.delete_reason ?? null,
        prior_deleted_at: info?.deleted_at ?? null,
        bulk: restored.length > 1,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidateQueueSurfaces(visitId);
  return { ok: true, count: restored.length };
}
