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
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { QueueDeleteReasonSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { QUEUE_DELETE_ROLES } from "@/lib/visits/deletion";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import { panelKey, type BulkQueueResult, type PanelRef, type SkippedRow } from "@/lib/queue/bulk-queue";
import { loadPanelMembers } from "@/lib/queue/panel-members";
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";

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
  // 0167: a queue restore puts a deleted visit's work back on the board —
  // refuse it on an inactive patient (restore the patient first).
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };
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

type VisitDeleteOutcome =
  | { ok: true; deletedIds: string[] }
  | { ok: false; error: string };

// Per-visit core shared by deleteTestRequestsAction (one visit) and
// deleteTestRequestsManyAction (a queue selection across visits). NOT
// exported: every export of a "use server" file is a public endpoint, and
// this trusts the session + reason its caller already checked.
async function deleteTestRequestsForVisit(
  session: StaffSession,
  visitId: string,
  testRequestIds: string[],
  reason: string,
  bulk?: { size: number; batchId?: string; panelKeyOf?: ReadonlyMap<string, string> },
): Promise<VisitDeleteOutcome> {
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

  // One UPDATE per visit — the 0125 guard raises P0042/P0043/P0044 for the
  // whole statement, so a mixed selection on one visit fails atomically
  // rather than half-deleting.
  const { data: deleted, error } = await admin
    .from("test_requests")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: session.user_id,
      delete_reason: reason,
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
        reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        final_price_php:
          info?.final_price_php != null ? Number(info.final_price_php) : null,
        is_package_header: info?.is_package_header ?? false,
        bulk: deleted.length > 1,
        ...(bulk
          ? {
              bulk_batch_size: bulk.size,
              ...(bulk.batchId ? { bulk_batch_id: bulk.batchId } : {}),
              ...(bulk.panelKeyOf?.get(row.id) ? { panel_key: bulk.panelKeyOf.get(row.id) } : {}),
            }
          : {}),
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidateQueueSurfaces(visitId);
  return { ok: true, deletedIds: deleted.map((r) => r.id) };
}

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
  const outcome = await deleteTestRequestsForVisit(
    session,
    visitId,
    testRequestIds,
    parsed.reason,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, count: outcome.deletedIds.length };
}

const ManyDeleteSchema = z
  .object({
    testRequestIds: z
      .array(z.string().uuid({ message: "Could not read the selection — refresh the queue and try again." }))
      .max(MAX_BULK_SELECTION, {
        message: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
      }),
    panels: z
      .array(z.object({ visitId: z.string().uuid(), groupId: z.string().uuid() }))
      .max(MAX_BULK_SELECTION)
      .default([]),
    reason: z.string(),
  })
  .refine(
    (v) =>
      v.testRequestIds.length + v.panels.length >= 1 &&
      v.testRequestIds.length + v.panels.length <= MAX_BULK_SELECTION,
    { message: "Nothing to delete — no tests were selected." },
  );

// The lab queue's bulk Delete (spec §6): a selection that can span visits, and
// may include whole chemistry panels (owner decision, item 10) resolved on
// the server to every live bench member — never trusted from the page. Order
// matters — role, then the input's shape and the reason, and only then the
// service-role reads — so an empty or unknown-id batch from a caller without
// the role gets the role error, never a candidate-dependent message. Each
// VISIT is its own atomic statement (deleteTestRequestsForVisit, one UPDATE —
// the 0125 guard raises for the whole statement on a single undeletable row),
// so a panel's members (always one visit) are all-or-nothing by construction:
// a panel key is only reported changed when every one of its members was
// deleted.
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
  const parsed = parseReason(shape.data.reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ids = Array.from(new Set(shape.data.testRequestIds));
  const panelsByKey = new Map<string, PanelRef>();
  for (const p of shape.data.panels) {
    const key = panelKey(p.visitId, p.groupId);
    if (!panelsByKey.has(key)) panelsByKey.set(key, { key, visitId: p.visitId, groupId: p.groupId });
  }
  const panels = [...panelsByKey.values()];

  const admin = createAdminClient();

  const loaded = await loadPanelMembers(admin, panels);
  if (!loaded.ok) {
    return { ok: false, error: "Could not load the chemistry panels — try again." };
  }
  const totalRecords =
    ids.length + [...loaded.members.values()].reduce((n, list) => n + list.length, 0);
  if (totalRecords > MAX_BULK_RECORDS) {
    return { ok: false, error: "Too many tests in one go — select fewer panels." };
  }

  const { data: candidates, error: readError } = await admin
    .from("test_requests")
    .select("id, visit_id")
    .in("id", ids)
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const visitOfSingle = new Map((candidates ?? []).map((c) => [c.id, c.visit_id]));

  // Selection key each underlying test_request id reports back as — itself
  // for a single, the panel key for every member of a panel.
  const keyOf = new Map<string, string>();
  const panelKeyOf = new Map<string, string>();
  const panelMembersOf = new Map<string, string[]>();
  const panelKeysByVisit = new Map<string, Set<string>>();
  const byVisit = new Map<string, string[]>();
  const skipped: SkippedRow[] = [];

  for (const id of ids) {
    const visitId = visitOfSingle.get(id);
    if (!visitId) {
      skipped.push({ id, reason: "Already deleted or no longer exists." });
      continue;
    }
    keyOf.set(id, id);
    const group = byVisit.get(visitId);
    if (group) group.push(id);
    else byVisit.set(visitId, [id]);
  }
  for (const panel of panels) {
    const list = loaded.members.get(panel.key) ?? [];
    if (list.length === 0) {
      skipped.push({ id: panel.key, reason: "Nothing left to delete in this panel — refresh the queue." });
      continue;
    }
    const memberIds = list.map((m) => m.id);
    panelMembersOf.set(panel.key, memberIds);
    const group = byVisit.get(panel.visitId);
    if (group) group.push(...memberIds);
    else byVisit.set(panel.visitId, [...memberIds]);
    for (const mid of memberIds) {
      keyOf.set(mid, panel.key);
      panelKeyOf.set(mid, panel.key);
    }
    const set = panelKeysByVisit.get(panel.visitId) ?? new Set<string>();
    set.add(panel.key);
    panelKeysByVisit.set(panel.visitId, set);
  }

  const changedIds: string[] = [];
  for (const [visitId, groupIds] of byVisit) {
    const outcome = await deleteTestRequestsForVisit(session, visitId, groupIds, parsed.reason, {
      size: totalRecords,
      panelKeyOf,
    });
    if (!outcome.ok) {
      const keysHere = new Set(groupIds.map((id) => keyOf.get(id)!));
      for (const key of keysHere) skipped.push({ id: key, reason: outcome.error });
      continue;
    }
    const done = new Set(outcome.deletedIds);
    for (const id of groupIds) {
      if (panelKeyOf.has(id)) continue; // panel members are reported per-panel below
      if (done.has(id)) changedIds.push(id);
      else skipped.push({ id, reason: "Already deleted or not deletable." });
    }
    for (const panelKeyHere of panelKeysByVisit.get(visitId) ?? []) {
      const memberIds = panelMembersOf.get(panelKeyHere)!;
      if (memberIds.every((mid) => done.has(mid))) {
        changedIds.push(panelKeyHere);
      } else {
        skipped.push({
          id: panelKeyHere,
          reason: "Part of this panel could not be deleted — open it to check.",
        });
      }
    }
  }
  return { ok: true, changedIds, skipped };
}

export async function restoreTestRequestsAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  // 0167: same as restoreVisitAction — a test-level restore puts work back
  // on the board.
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };
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
