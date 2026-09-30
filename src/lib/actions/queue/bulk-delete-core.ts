import "server-only";

// The body of the lab queue's bulk Delete for SINGLE tests, plus the per-visit
// delete it shares with deleteTestRequestsAction. Plain server-only module —
// NOT "use server" — so the batch id can be an argument (see bulk-cores.ts for
// why a browser must never supply one). Kept apart from bulk-cores.ts because a
// delete means the whole bill line (any kind, and a line on a deleted visit is
// refused with its own message), where claim / unclaim mean lab work on live
// rows — query-surfaces.test.ts classifies whole files.

import { audit } from "@/lib/audit/log";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StaffSession } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { QUEUE_DELETE_ROLES } from "@/lib/visits/deletion";
import { QueueDeleteReasonSchema } from "@/lib/validations/accounting";
import { revalidateQueueSurfaces } from "@/lib/actions/visits/queue-restore-core";
import { readInChunks } from "@/lib/supabase/in-chunks";
import {
  ALREADY_DELETED_REASON,
  NOTHING_TO_DELETE_REFUSAL,
  type BulkQueueResult,
  type SkippedRow,
} from "@/lib/queue/bulk-queue";
import type { BulkBatchContext } from "@/lib/actions/queue/bulk-cores";

export const NOT_QUEUE_DELETE_STAFF = "Only reception or admin can delete queue entries.";

export function parseQueueDeleteReason(
  reason: string,
): { ok: true; reason: string } | { ok: false; error: string } {
  const parsed = QueueDeleteReasonSchema.safeParse({ reason });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Reason is required.",
    };
  }
  return { ok: true, reason: parsed.data.reason };
}

export type VisitDeleteOutcome =
  | { ok: true; deletedIds: string[] }
  | { ok: false; error: string };

/** Audit extras for a bulk delete: the batch identity, plus the panel a delete belongs to. */
export interface BulkDeleteAudit {
  size: number;
  batchId?: string;
  panelKey?: string;
}

// Per-visit core shared by deleteTestRequestsAction (one visit) and
// deleteTestRequestsManyCore (a queue selection across visits). Plain module,
// so it is never an endpoint: it trusts the session + reason its caller
// already checked.
export async function deleteTestRequestsForVisit(
  session: StaffSession,
  visitId: string,
  testRequestIds: string[],
  reason: string,
  bulk?: BulkDeleteAudit,
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
  // rather than half-deleting. The exact timestamp rides the audit metadata
  // below so a bulk Undo can predicate its restore on it (P1: exact
  // predicates) rather than restoring whatever is currently deleted.
  const deletedAtIso = new Date().toISOString();
  const { data: deleted, error } = await admin
    .from("test_requests")
    .update({
      deleted_at: deletedAtIso,
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
        deleted_at: deletedAtIso,
        ...(bulk
          ? {
              bulk_batch_size: bulk.size,
              ...(bulk.batchId ? { bulk_batch_id: bulk.batchId } : {}),
              ...(bulk.panelKey ? { panel_key: bulk.panelKey } : {}),
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

// The lab queue's bulk Delete (spec §6): a selection that can span visits.
// Each VISIT is its own atomic statement (deleteTestRequestsForVisit, one
// UPDATE — the 0125 guard raises for the whole statement on a single
// undeletable row). A chemistry panel is deleted whole by panel-actions.ts,
// which calls this with the panel's full member list as testRequestIds — one
// visit, so still one atomic statement — and its `panelKey`, which rides every
// audit row so the panel's Undo can find its members.
export async function deleteTestRequestsManyCore(
  session: StaffSession,
  input: { testRequestIds: string[]; reason: string },
  ctx: BulkBatchContext & { panelKey?: string },
): Promise<BulkQueueResult> {
  if (!QUEUE_DELETE_ROLES.has(session.role)) {
    return { ok: false, error: NOT_QUEUE_DELETE_STAFF };
  }
  const parsed = parseQueueDeleteReason(input.reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ids = Array.from(new Set(input.testRequestIds));

  const admin = createAdminClient();

  // Chunked (IN_CHUNK): a panel's member list can be long, and a failed slice
  // refuses the call before any write (never "those ids are already gone").
  const read = await readInChunks(ids, (chunk) =>
    admin.from("test_requests").select("id, visit_id").in("id", chunk).is("deleted_at", null),
  );
  if (!read.ok) return { ok: false, error: translatePgError(read.error) };
  const candidates = read.rows;
  // Every id already deleted (or gone) — refuse before any write or audit row,
  // so a stale selection reads as a clear error, not an empty "success".
  // panel-actions.ts relies on this ok:false shape.
  if (candidates.length === 0) {
    return { ok: false, error: NOTHING_TO_DELETE_REFUSAL };
  }
  const visitOfSingle = new Map(candidates.map((c) => [c.id, c.visit_id]));

  const byVisit = new Map<string, string[]>();
  const skipped: SkippedRow[] = [];

  for (const id of ids) {
    const visitId = visitOfSingle.get(id);
    if (!visitId) {
      skipped.push({ id, reason: ALREADY_DELETED_REASON });
      continue;
    }
    const group = byVisit.get(visitId);
    if (group) group.push(id);
    else byVisit.set(visitId, [id]);
  }

  const changedIds: string[] = [];
  for (const [visitId, groupIds] of byVisit) {
    const outcome = await deleteTestRequestsForVisit(session, visitId, groupIds, parsed.reason, {
      size: ctx.batchSize,
      batchId: ctx.batchId,
      panelKey: ctx.panelKey,
    });
    if (!outcome.ok) {
      for (const id of groupIds) skipped.push({ id, reason: outcome.error });
      continue;
    }
    const done = new Set(outcome.deletedIds);
    for (const id of groupIds) {
      if (done.has(id)) changedIds.push(id);
      else skipped.push({ id, reason: "Already deleted or not deletable." });
    }
  }
  return { ok: true, changedIds, skipped, batchId: ctx.batchId };
}
