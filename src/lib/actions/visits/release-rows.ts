import "server-only";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffSession } from "@/lib/auth/require-staff";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { isActivePatient, type PatientLifecycle } from "@/lib/patients/active";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { audit } from "@/lib/audit/log";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { notifyResultsReleasedBulk } from "@/lib/notifications/notify-released-bulk";
import { reportError } from "@/lib/observability/report-error";
import type { Json } from "@/types/database";
import type { ReleaseMedium } from "@/lib/visits/release-media";
import { RELEASE_REFUSAL_PATIENT_INACTIVE } from "@/lib/visits/release-messages";

export type ReleasedRow = { id: string; name: string };

type Lifecycle = Pick<PatientLifecycle, "deleted_at" | "merged_into_id">;
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * The one release write (visit page bulk bar + lab queue). Section-scopes the
 * candidates (RLS is role-only), flips ready_for_release → released in ONE
 * statement, audits each row the statement actually returned, and returns
 * those rows — the authoritative write set. It does NOT notify: the caller
 * decides (the queue withholds the notice for a combined report that did not
 * end fully released). Payment/consent/GL/package triggers fire as usual.
 */
export async function releaseRows(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  ids: readonly string[];
  medium: ReleaseMedium;
  auditMeta?: Record<string, Json>;
}): Promise<{ ok: true; released: ReleasedRow[] } | { ok: false; error: string }> {
  const { supabase, session, visitId, ids, medium } = args;
  // Lab read of test_requests: doctor lines never reach ready_for_release by
  // design, but the queue guard wants the marker here, not by inference.
  const { data: candidates, error: readErr } = await supabase
    .from("test_requests")
    .select(
      "id, deleted_at, services!inner ( section, name, kind ), visits!inner ( deleted_at, patients!inner ( deleted_at, merged_into_id ) )",
    )
    .in("id", [...ids])
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .eq("is_package_header", false)
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  const rows = candidates ?? [];
  // The read above pins live, ready lines on a live visit; here a merged or
  // deleted patient's lines are refused so the write does not depend on every
  // caller checking (write-guards). Nothing in the DB blocks releasing a
  // deleted line/visit (0146 documents this), so a delete landing between this
  // read and the UPDATE below is not refused by a trigger; the UPDATE re-pins
  // `deleted_at IS NULL` itself so a just-deleted line is simply not released.
  const live = rows.filter((r) => {
    const v = one(r.visits as unknown as { patients: Lifecycle | Lifecycle[] | null } | null);
    const p = one(v?.patients);
    // isActivePatient wants a full PatientLifecycle (incl. drm_id), but only
    // deleted_at / merged_into_id are read here, so the id is a placeholder.
    return isActivePatient(p ? { drm_id: "", ...p } : null);
  });
  if (live.length !== rows.length) {
    return { ok: false, error: RELEASE_REFUSAL_PATIENT_INACTIVE };
  }
  const scoped = scopeToAllowedSections(live, sectionsForRole(session.role));
  if (scoped.length === 0) return { ok: true, released: [] };

  // One instant for the whole statement, recorded on every audit row below:
  // a 10-minute Undo (undoReleaseBatchAction) predicates its revert on this
  // exact release, so a row unreleased and re-released by someone else in
  // between never comes back.
  const releasedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: releasedAt,
      released_by: session.user_id,
      release_medium: medium,
    })
    .in("id", scoped.map((r) => r.id))
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .is("deleted_at", null)
    .select("id, services ( name )");
  if (error) return { ok: false, error: translatePgError(error) };

  const released: ReleasedRow[] = (updated ?? []).map((r) => {
    const s = one(r.services as unknown as { name: string } | { name: string }[] | null);
    return { id: r.id as string, name: s?.name ?? "Result" };
  });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  for (const row of released) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.released",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        release_medium: medium,
        bulk: true,
        selection: true,
        ...args.auditMeta,
        released_at: releasedAt,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }
  return { ok: true, released };
}

/** The patient "result ready" notice for rows a caller decided to announce. Never throws. */
export async function notifyReleased(
  visitId: string,
  rows: readonly ReleasedRow[],
  medium: ReleaseMedium,
  // The release call's bulk_batch_id, stamped on the notice's own audit row
  // so the batch's Undo does not read it as a later, unrelated change.
  bulkBatchId?: string,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    if (rows.length === 1) {
      await notifyResultReleased({ testRequestId: rows[0].id, visitId, releaseMedium: medium, bulkBatchId });
    } else {
      await notifyResultsReleasedBulk({
        visitId,
        testRequestIds: rows.map((r) => r.id),
        testNames: rows.map((r) => r.name),
        releaseMedium: medium,
        bulkBatchId,
      });
    }
  } catch (err) {
    await reportError({
      scope: "notify/result-released-selection",
      error: err,
      metadata: { visit_id: visitId, test_request_ids: rows.map((r) => r.id) },
    });
  }
}
