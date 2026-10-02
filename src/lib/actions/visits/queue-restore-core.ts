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
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { sameInstant } from "@/lib/ui/bulk-undo";
import { groupIdsByDeletedAt } from "@/lib/queue/partial-panel";

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

  // Both branches write through restore_test_request_lines (0216), which takes
  // the locks first in the global order (patient, visit FOR UPDATE, lines + a
  // header's components by id) — a bare UPDATE here locked the line first and
  // the visit only through 0183's waived guard, deadlocking with release and
  // undo. Retried once on a lost race (P0072 / 40P01): it rolls back whole.
  let restored: { id: string }[];
  if (expectedDeletedAtOf) {
    // One call per distinct deleted_at value read above, each predicated on
    // that EXACT value — not merely "deleted_at is not null" like the branch
    // below. Without this, a restore-and-re-delete landing in the instant
    // between the read above and this write would still satisfy "is not
    // null" and get silently undone by a bulk Undo it has nothing to do with
    // (P1, finding 3). The rows here already passed the sameInstant filter
    // against expectedDeletedAtOf, so grouping by their own (matching)
    // deleted_at is exactly grouping by what each id was expected to carry.
    const byDeletedAt = groupIdsByDeletedAt(rows.map((r) => ({ id: r.id, deleted_at: r.deleted_at! })));
    restored = [];
    let firstError: { code?: string; message?: string; details?: string } | null = null;
    for (const [deletedAtValue, ids] of byDeletedAt) {
      const { data, error: writeError } = await withLifecycleRetry(() =>
        admin.rpc("restore_test_request_lines", {
          p_visit_id: visitId,
          p_test_request_ids: ids,
          p_deleted_at: deletedAtValue,
        }),
      );
      if (writeError) {
        firstError ??= writeError;
        continue;
      }
      restored.push(...(data ?? []).map((id) => ({ id })));
    }
    if (restored.length === 0) {
      return { ok: false, error: firstError ? translatePgError(firstError) : "None of the selected tests can be restored." };
    }
  } else {
    // Manual Restore path (restoreTestRequestsAction): no expected value to
    // pin the write to, so the function's "deleted_at is not null" predicate
    // (no p_deleted_at) applies, as the bare UPDATE's did.
    const { data, error } = await withLifecycleRetry(() =>
      admin.rpc("restore_test_request_lines", {
        p_visit_id: visitId,
        p_test_request_ids: rows.map((r) => r.id),
      }),
    );
    if (error) return { ok: false, error: translatePgError(error) };
    if (!data || data.length === 0) {
      return { ok: false, error: "None of the selected tests can be restored." };
    }
    restored = data.map((id) => ({ id }));
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
