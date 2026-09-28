import "server-only";

/**
 * Server-only core shared by `restoreTestRequestsAction` (queue-deletion.ts)
 * and the lab queue's bulk Undo (`undoBulkQueueAction`, queue/actions.ts).
 * Not a "use server" file — every export of one of those is a public
 * endpoint, and this trusts its caller for the session, role and reason.
 */

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import type { StaffSession } from "@/lib/auth/require-staff";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import { sameInstant } from "@/lib/ui/bulk-undo";

// Every surface that renders visits or queue rows and must drop (or show)
// deleted entries immediately. Moved here from queue-deletion.ts so both
// restoreTestRequestsForVisit (below) and every other export there can use
// it without a circular import.
export function revalidateQueueSurfaces(visitId: string) {
  revalidatePath("/staff/visits/queue");
  revalidatePath("/staff/queue");
  revalidatePath("/staff/visits");
  revalidatePath("/staff/results");
  revalidatePath(`/staff/visits/${visitId}`);
}

export type RestoreOutcome =
  | { ok: true; restoredIds: string[] }
  | { ok: false; error: string };

/**
 * Restores queue-deleted tests on one visit. Trusts its caller for the
 * session, role and reason (restoreTestRequestsAction; the bulk Undo) — it is
 * NOT a server action. `extraMetadata` rides on every audit row.
 *
 * `expectedDeletedAtOf` (bulk Undo only): the exact `deleted_at` each id was
 * recorded as carrying when the original bulk delete wrote it. When given, a
 * candidate is restorable only while its CURRENT `deleted_at` still matches —
 * otherwise it was restored-and-re-deleted (or never touched by this batch at
 * all) by someone else since, and Undo must not reverse that newer change
 * (P1). `restoreTestRequestsAction` passes nothing, so it is unaffected.
 */
export async function restoreTestRequestsForVisit(
  session: StaffSession,
  visitId: string,
  testRequestIds: string[],
  reason: string,
  extraMetadata: Record<string, unknown> = {},
  expectedDeletedAtOf?: ReadonlyMap<string, string>,
): Promise<RestoreOutcome> {
  // 0167: a queue restore puts a deleted visit's work back on the board —
  // refuse it on an inactive patient (restore the patient first).
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };

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
  let rows = candidates ?? [];
  if (expectedDeletedAtOf) {
    // sameInstant, not ===: PostgREST normalizes a "Z"-suffixed timestamp to
    // "+00:00" on read-back, so a raw string compare against the value
    // recorded in audit metadata (via new Date().toISOString()) never
    // matches even when it's the exact same instant.
    rows = rows.filter((r) => sameInstant(expectedDeletedAtOf.get(r.id), r.deleted_at));
  }
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
        reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        prior_delete_reason: info?.delete_reason ?? null,
        prior_deleted_at: info?.deleted_at ?? null,
        bulk: restored.length > 1,
        ...extraMetadata,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidateQueueSurfaces(visitId);
  return { ok: true, restoredIds: restored.map((r) => r.id) };
}
