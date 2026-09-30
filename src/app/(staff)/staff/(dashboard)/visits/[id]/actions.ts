"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { loadOwnBatchRows } from "@/lib/audit/bulk-batch";
import {
  BULK_UNDO_VIA,
  CHANGED_SINCE_REASON,
  UNDO_ALREADY,
  UNDO_EXPIRED,
  type BulkUndoResult,
} from "@/lib/ui/bulk-undo";
import {
  QueueDeleteReasonSchema,
  WaiveBalanceSchema,
} from "@/lib/validations/accounting";
import { WAIVE_CLOSED_MONTH_MESSAGE } from "@/lib/visits/payment-edit";
import { deleteVisitAction } from "@/lib/actions/visits/queue-deletion";
import {
  releaseVisitSelection,
  type VisitReleaseOutcome,
} from "@/lib/actions/visits/release-reports";
import { RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import type { SkippedRow } from "@/lib/queue/bulk-queue";
import {
  hasOpenHmoClaim,
  visitDeletability,
  withoutReleased,
} from "@/lib/visits/deletion";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  MAX_BULK_SELECTION,
  scopeToAllowedSections,
} from "@/lib/visits/bulk-selection";
import { countResultViews } from "@/lib/results/viewed-count";
import { canManuallyReleasePackageHeader } from "@/lib/visits/package-header-release";
import { isReleaseMedium, type ReleaseMedium } from "@/lib/visits/release-media";



export type ReleaseResult =
  | { ok: true }
  | { ok: false; error: string };

// Bulk-selection actions additionally report how many rows the UPDATE
// actually touched, so the UI can tell the user when part of the selection
// was skipped (already handled by a concurrent action, or outside the
// caller's section scope). Used by undoReleaseSelectedAction and
// deleteSampleVisitAction — the older per-row/per-package actions keep the
// plain ReleaseResult shape.
export type BulkSelectionResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

/**
 * Refuse to act on a soft-deleted visit (0125).
 *
 * Deleting a VISIT does not cascade to its `test_requests` — the only cascade
 * is package header → components — so a deleted visit keeps a full set of
 * live-looking lines. The visit page still renders them (it has to: reception
 * needs the deletion reason and the Restore button), and nothing downstream
 * stopped a release: `enforce_payment_before_release` passes an HMO visit
 * while it is unpaid (0133), and `payment_status = 'unpaid'` is exactly what
 * makes a visit deletable (P0042). So a deleted HMO visit's lines were
 * releasable, and releasing one emailed the patient about a visit the clinic
 * had removed.
 *
 * Checked once per action rather than as a `visits!inner` embed on each read:
 * these actions address rows by id, several of their selects are consumed by
 * hand-shaped row types, and an explicit refusal reads better than a row that
 * silently stops matching.
 */
async function refuseIfVisitDeleted(
  supabase: Awaited<ReturnType<typeof createClient>>,
  visitId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data: visit } = await supabase
    .from("visits")
    .select("deleted_at")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) return { ok: false, error: "Visit not found." };
  if (visit.deleted_at !== null) {
    return {
      ok: false,
      error:
        "This visit was deleted from the queue. Restore it before releasing results.",
    };
  }
  // 0167: history of a deleted or merged patient stays readable, but no
  // release, undo or mark-done until the record is restored.
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false as const, error: active.error };
  return null;
}

// Every surface that shows a line's release state. A TYPED revalidatePath
// must name the route FILE path, route groups included — "/staff/queue" +
// "layout" matches no tag (next/…/revalidate.js). The layout revalidation
// covers /staff/queue, /staff/queue/[id] and the consolidated report page;
// "/staff" (untyped, a concrete URL) is the dashboard.
function revalidateReleaseSurfaces(visitId: string) {
  revalidatePath(`/staff/visits/${visitId}`);
  revalidatePath("/(staff)/staff/(dashboard)/queue", "layout");
  revalidatePath("/staff");
}

/** The three visit-page lab release actions (rev 5: new names — `ReleaseResult` / `BulkSelectionResult` are NOT widened). */
export type VisitReleaseResult =
  | { ok: true; changedCount: number; alsoReleasedCount: number; skipped: SkippedRow[]; warnings: string[] }
  | { ok: false; error: string };
export type VisitBulkReleaseResult =
  | {
      ok: true;
      count: number;
      alsoReleasedCount: number;
      skipped: SkippedRow[];
      warnings: string[];
      /** releaseSelectedAction only: the Undo handle (undoReleaseBatchAction). */
      batchId?: string;
      /** releaseSelectedAction only: released tests the patient was told about. */
      notifiedCount?: number;
    }
  | { ok: false; error: string };

/**
 * Releases one test. A test on a combined chemistry report releases the whole
 * report or nothing (releaseVisitSelection): the portal only serves a report
 * once every linked test is released.
 */
export async function releaseTestAction(
  testRequestId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<VisitReleaseResult> {
  if (!isReleaseMedium(releaseMedium)) {
    return { ok: false, error: "Invalid release medium." };
  }
  const session = await requireActiveStaff();
  // The lab releases results, never reception (owner rule 2026-09-15) — the
  // same refusal the Queue gives (evaluateRelease), not a misleading "not ready".
  if (session.role === "reception") return { ok: false, error: RELEASE_REFUSAL.reception };
  const supabase = await createClient();

  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  // Section gate, server-side (mirrors releaseSelectedAction). RLS on
  // test_requests is role-only, not section-aware (0023), so the action has to
  // prove the row sits in a section this role may release. Doctor lines carry
  // a null section and therefore survive only for admin/pathologist (null =
  // unrestricted) — see scopeToAllowedSections.
  const allowedSections = sectionsForRole(session.role);
  const { data: candidate } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .is("deleted_at", null)
    .maybeSingle();
  if (!candidate) {
    revalidateReleaseSurfaces(visitId);
    return { ok: false, error: RELEASE_REFUSAL.notReady };
  }
  if (scopeToAllowedSections([candidate], allowedSections).length === 0) {
    revalidateReleaseSurfaces(visitId);
    return { ok: false, error: RELEASE_REFUSAL.section };
  }

  const out = await releaseVisitSelection({
    supabase,
    session,
    visitId,
    selectedIds: [testRequestId],
    medium: releaseMedium,
    auditMeta: { source: "visit_page", bulk: false, selection: false },
  });
  revalidateReleaseSurfaces(visitId);
  return visitReleaseResult(out);
}

// A write happened if EITHER list has rows (a pulled-in sibling can release
// even when the selected row raced away) — then report it, never a bare error.
function visitReleaseResult(out: VisitReleaseOutcome): VisitReleaseResult {
  if (out.changedIds.length === 0 && out.alsoReleasedIds.length === 0) {
    return { ok: false, error: out.skipped[0]?.reason ?? RELEASE_REFUSAL.notReady };
  }
  return {
    ok: true,
    changedCount: out.changedIds.length,
    alsoReleasedCount: out.alsoReleasedIds.length,
    skipped: out.skipped,
    warnings: out.warnings,
  };
}

// Releases every component of a package that's ready (payment + consent
// gates already cleared per-row). The package header is NOT touched here —
// migration 0109's Leg A trigger auto-releases it once the last component
// goes terminal on a paid visit. A component on a combined chemistry report
// pulls in (or is refused with) the rest of that report, exactly like the
// queue: `changedCount` is what this write released of the package,
// `alsoReleasedCount` the report members outside it.
export async function releaseAllReadyComponentsAction(
  headerId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<VisitReleaseResult> {
  if (!isReleaseMedium(releaseMedium)) {
    return { ok: false, error: "Invalid release medium." };
  }
  const session = await requireActiveStaff();
  // The lab releases results, never reception (owner rule 2026-09-15) — the
  // same refusal the Queue gives (evaluateRelease), not a misleading "not ready".
  if (session.role === "reception") return { ok: false, error: RELEASE_REFUSAL.reception };
  const supabase = await createClient();

  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  // Verify the target really is a package header on this visit.
  const { data: header } = await supabase
    .from("test_requests")
    .select("id, is_package_header, visit_id")
    .eq("id", headerId)
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!header?.is_package_header) {
    return { ok: false, error: "Package not found on this visit." };
  }

  // Section scope — mirror the visit page's SELECT-side filter exactly.
  // RLS is role-only, NOT section-aware (0023), so without this the app
  // layer would let a medtech's bulk click release components they never
  // saw on screen (the page's "Release all ready (N)" count is filtered
  // through sectionsForRole, e.g. an X-ray hidden from a medtech) — under
  // their audit identity (RA 10173) and beyond what the button label
  // promised. Same semantics as page.tsx: `null` = unrestricted
  // (admin/pathologist), `[]` = no sections (reception), otherwise only
  // components whose service section is in the allowed set.
  const allowedSections = sectionsForRole(session.role);
  const { data: readyRows } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name )")
    .eq("parent_id", headerId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .is("deleted_at", null);
  const componentIds = scopeToAllowedSections(readyRows ?? [], allowedSections).map((r) => r.id);
  if (componentIds.length === 0) {
    revalidateReleaseSurfaces(visitId);
    return {
      ok: false,
      error: (readyRows ?? []).length > 0 ? RELEASE_REFUSAL.section : "No components are ready to release.",
    };
  }

  const out = await releaseVisitSelection({
    supabase,
    session,
    visitId,
    selectedIds: componentIds,
    medium: releaseMedium,
    auditMeta: { source: "visit_page", bulk: true, package_header_id: headerId },
  });
  revalidateReleaseSurfaces(visitId);
  return visitReleaseResult(out);
}

// A3 (go-live): admin-only escape hatch for a package header stuck at
// ready_for_release. Normally migration 0109's Leg A trigger
// (fn_release_header_when_components_done) auto-releases the header the
// moment its last component goes terminal on a money-settled visit — but
// there is currently no UI path at all to release a header by hand when
// that trigger doesn't fire (headers never reach TestAction; ReleaseAllButton
// only ever targets components; bulk actions filter is_package_header=false).
// This action writes the exact same fields the trigger would have written
// (status/released_at/released_by/release_medium='other') through an UPDATE
// that still runs through enforce_payment_before_release (0133) — the
// payment-gating trigger is never bypassed, and the service-role client is
// never reached for here.
export async function releasePackageHeaderAction(
  headerId: string,
  visitId: string,
): Promise<ReleaseResult> {
  const session = await requireAdminStaff();
  const supabase = await createClient();

  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  const { data: header } = await supabase
    .from("test_requests")
    .select("id, status, is_package_header")
    .eq("id", headerId)
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!header?.is_package_header) {
    return { ok: false, error: "Package not found on this visit." };
  }

  const { data: components } = await supabase
    .from("test_requests")
    .select("id, status")
    .eq("parent_id", headerId)
    .eq("visit_id", visitId)
    .is("deleted_at", null);

  if (!canManuallyReleasePackageHeader(header, components ?? [])) {
    return {
      ok: false,
      error:
        "This package can only be released once every component is released or cancelled.",
    };
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: "other",
    })
    .eq("id", headerId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .select("id");

  if (error) {
    // The payment-gating trigger (enforce_payment_before_release, 0133) is
    // the source of truth — this is the same check_violation path every
    // other release goes through.
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated || updated.length === 0) {
    // A concurrent action (or the Leg A trigger itself, on the read above)
    // already released it. Never audit a write that didn't happen.
    revalidateReleaseSurfaces(visitId);
    return { ok: false, error: "This package is no longer ready to release." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.released",
    resource_type: "test_request",
    resource_id: headerId,
    metadata: {
      visit_id: visitId,
      release_medium: "other",
      manual_header_release: true,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidateReleaseSurfaces(visitId);
  return { ok: true };
}

// Releases a hand-picked selection of ready components/standalone tests.
// Package headers are never included in the selection (is_package_header =
// false is part of the pre-SELECT filter) — if a selection happens to
// complete a package, migration 0109's Leg A trigger auto-releases the header
// exactly as it does for the package bulk action. A test on a combined
// chemistry report releases with the rest of its report or is skipped with
// the reason (releaseVisitSelection); ids that were not ready candidates are
// skipped too, so the caller can say why fewer were released.
export async function releaseSelectedAction(
  visitId: string,
  testRequestIds: string[],
  releaseMedium: ReleaseMedium,
): Promise<VisitBulkReleaseResult> {
  if (!isReleaseMedium(releaseMedium)) {
    return { ok: false, error: "Invalid release medium." };
  }
  if (testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }
  if (testRequestIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      error: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    };
  }

  const session = await requireActiveStaff();
  // The lab releases results, never reception (owner rule 2026-09-15) — the
  // same refusal the Queue gives (evaluateRelease), not a misleading "not ready".
  if (session.role === "reception") return { ok: false, error: RELEASE_REFUSAL.reception };
  const supabase = await createClient();

  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  // Section-scoped candidates (RLS is role-only): live, ready, non-header
  // lines of this visit that this role may release (releaseRows also refuses
  // doctor lines; they never reach ready_for_release).
  const { data: readyRows, error: readErr } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name, kind )")
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .eq("is_package_header", false)
    .is("deleted_at", null);
  if (readErr) {
    revalidateReleaseSurfaces(visitId);
    return { ok: false, error: translatePgError(readErr) };
  }
  const scoped = new Set(
    scopeToAllowedSections(readyRows ?? [], sectionsForRole(session.role)).map((r) => r.id),
  );
  if (scoped.size === 0) {
    revalidateReleaseSurfaces(visitId);
    return {
      ok: false,
      // Ready rows the role may not release get the section reason, not "not ready".
      error: (readyRows ?? []).length > 0
        ? RELEASE_REFUSAL.section
        : "None of the selected tests are ready to release.",
    };
  }
  const requested = Array.from(new Set(testRequestIds));
  const scopedIds = requested.filter((id) => scoped.has(id));

  // Undo (owner 2026-09-28): one server-minted batch id for this call.
  // releaseVisitSelection stamps it, with the exact released_at, on the audit
  // row of EVERY test it releases — report-mates it pulls in included — and
  // on the patient notice, so undoReleaseBatchAction can read back exactly
  // what this call released (loadOwnBatchRows). Only returned to the caller
  // once at least one row actually released (below).
  const batchId = crypto.randomUUID();

  const out = await releaseVisitSelection({
    supabase,
    session,
    visitId,
    selectedIds: scopedIds,
    medium: releaseMedium,
    auditMeta: { source: "visit_page", bulk: true, selection: true },
    bulkBatchId: batchId,
  });
  revalidateReleaseSurfaces(visitId);

  // Ids the caller sent that were not candidates, merged into request order.
  const reasonOf = new Map(out.skipped.map((s) => [s.id, s.reason]));
  const skipped: SkippedRow[] = [];
  for (const id of requested) {
    if (!scoped.has(id)) skipped.push({ id, reason: RELEASE_REFUSAL.notReady });
    else if (reasonOf.has(id)) skipped.push({ id, reason: reasonOf.get(id)! });
  }
  if (out.changedIds.length === 0 && out.alsoReleasedIds.length === 0) {
    return { ok: false, error: skipped[0]?.reason ?? RELEASE_REFUSAL.notReady };
  }
  return {
    ok: true,
    count: out.changedIds.length,
    alsoReleasedCount: out.alsoReleasedIds.length,
    skipped,
    warnings: out.warnings,
    batchId,
    notifiedCount: out.notice?.status === "sent" ? out.announced.length : 0,
  };
}

// notifiedCount (the bar's "already notified" line) is the real outcome of the
// patient notice: every announced test when a message actually went out, 0 for
// a report withheld as unverified, a physical / pickup hand-off, a sample
// visit, a patient with no contact details or a failed send.

// Server-checked 10-minute Undo for releaseSelectedAction (owner 2026-09-28):
// same window/same-staff/own-batch rules as every other bulk Undo
// (loadOwnBatchRows), reusing undoReleasedRows — the exact core the
// hand-picked undoReleaseSelectedAction runs — so the reason ("Undone within
// 10 minutes of release", automatic, no prompt), the whole-report expansion
// (0172) and the "patient already viewed" audit snapshot all behave
// identically to a manual Unrelease. Its audit rows carry `via: BULK_UNDO_VIA`
// plus `undo_of_batch`/`bulk_batch_id` (a NEW batch id, so this Undo is
// itself undo-batch-traceable, though nothing currently re-undoes an Undo).
// A combined (chemistry) report is released whole (releaseVisitSelection), so
// every member this batch pulled in carries its own audit row in the batch
// and the report comes back whole. The bar's outcome message counts
// `restoredIds.length` — the true number put back, report-mates included.
export async function undoReleaseBatchAction(
  input: { batchId: string },
): Promise<BulkUndoResult> {
  const parsed = z.object({ batchId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: UNDO_EXPIRED };

  const session = await requireActiveStaff();

  const loaded = await loadOwnBatchRows({
    actorId: session.user_id,
    batchId: parsed.data.batchId,
    resourceType: "test_request",
    nowMs: Date.now(),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.alreadyUndone) return { ok: false, error: UNDO_ALREADY };

  const releasedRows = loaded.rows.filter(
    (r) => r.action === "test_request.released",
  );
  if (releasedRows.length === 0) return { ok: false, error: UNDO_EXPIRED };

  const notRestored: Array<{ id: string; reason: string }> = [];
  const candidateIds: string[] = [];
  // Every id THIS batch released (has its own test_request.released audit row
  // in it), regardless of changedSince — only these are ever named in
  // notRestored, never a report-mate released separately (Finding 4, P1).
  const batchReleasedIds = new Set<string>();
  // testRequestId -> the exact released_at this batch's audit row recorded —
  // the release identity undoReleasedRows' write is predicated on below.
  const expectedReleasedAtOf = new Map<string, string>();
  const seen = new Set<string>();
  let visitId: string | null = null;
  for (const row of releasedRows) {
    const id = row.resource_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (visitId === null) {
      const vid = row.metadata?.visit_id;
      if (typeof vid === "string") visitId = vid;
    }
    batchReleasedIds.add(id);
    const releasedAt = row.metadata?.released_at;
    if (typeof releasedAt === "string") expectedReleasedAtOf.set(id, releasedAt);
    if (loaded.changedSince.has(id)) {
      notRestored.push({ id, reason: CHANGED_SINCE_REASON });
      continue;
    }
    candidateIds.push(id);
  }
  // releaseVisitSelection always stamps visit_id — a batch with none of its
  // rows carrying it is not a batch this action wrote.
  if (!visitId) return { ok: false, error: UNDO_EXPIRED };
  if (candidateIds.length === 0) {
    return notRestored.length > 0
      ? { ok: true, restoredIds: [], notRestored }
      : { ok: false, error: UNDO_EXPIRED };
  }

  const supabase = await createClient();

  // Finding 4 (P1), 0198: combined reports come back whole or not at all, and
  // only as THIS batch released them. The rule is decided by undo_visit_release
  // under its locks, from the identity map: a member changed since this batch
  // (by audit) is left out of it, and the database restores a report only when
  // EVERY member is in the map and still carries that exact release — so a
  // member this batch never released, or one changed since, keeps its whole
  // report released, and a line re-released by someone else inside the window
  // never comes back. A row whose audit row lacks released_at is not in the
  // map either, so it is refused rather than restored on a guess.
  const expectedForUndo = new Map(
    [...expectedReleasedAtOf].filter(([id]) => !loaded.changedSince.has(id)),
  );

  const undoBatchId = crypto.randomUUID();
  const result = await undoReleasedRows(
    supabase,
    session,
    visitId,
    candidateIds,
    "Undone within 10 minutes of release",
    {
      bulk: true,
      via: BULK_UNDO_VIA,
      undo_of_batch: parsed.data.batchId,
      bulk_batch_id: undoBatchId,
    },
    expectedForUndo,
  );
  // The Queue's Pending release tab and the dashboard cards list ready
  // work too (#261), so refresh every release surface, as Unrelease does.
  revalidateReleaseSurfaces(visitId);
  if (!result.ok) return { ok: false, error: result.error };

  // Name only tests THIS batch released — a report-mate released separately is
  // why its report stayed, not one of the actor's own rows.
  for (const id of result.skippedIds) {
    if (batchReleasedIds.has(id) && !notRestored.some((n) => n.id === id)) {
      notRestored.push({ id, reason: CHANGED_SINCE_REASON });
    }
  }
  const restoredSet = new Set(result.undoneIds);
  return {
    ok: true,
    restoredIds: result.undoneIds,
    notRestored: notRestored.filter((n) => !restoredSet.has(n.id)),
  };
}

// Undoes a hand-picked selection of released rows back to ready_for_release.
// Migration 0110's trigger reverses each row's JE (a no-op for ₱0 package
// components), voids any open PF/COGS subledger rows, and cascades the
// header flip + header JE reversal when a component undo completes the
// package's un-release. NO notification is sent — undo is a corrective
// action, not a result delivery event.
export async function undoReleaseSelectedAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<BulkSelectionResult> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return { ok: false, error: "Reason is required." };
  }
  if (testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }
  if (testRequestIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      error: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    };
  }

  const session = await requireActiveStaff();
  const supabase = await createClient();

  const result = await undoReleasedRows(
    supabase,
    session,
    visitId,
    testRequestIds,
    trimmedReason,
    { bulk: true },
  );
  revalidateReleaseSurfaces(visitId);
  return result.ok ? { ok: true, count: result.undoneIds.length } : result;
}

type UndoRowsResult =
  | { ok: true; undoneIds: string[]; skippedIds: string[] }
  | { ok: false; error: string };

const COULDNT_CONFIRM_UNDO =
  "Couldn't confirm what was undone — check the visit page.";

interface UndoneRow {
  id: string;
  prior_release_medium: string | null;
  prior_released_at: string | null;
  report_id: string | null;
}

/** Hand-checks undo_visit_release's jsonb ({ undone: [...], skipped: [...] }); null when malformed. */
function parseUndoResult(data: unknown): { undone: UndoneRow[]; skippedIds: string[] } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { undone: list, skipped } = data as { undone?: unknown; skipped?: unknown };
  if (!Array.isArray(list) || !Array.isArray(skipped)) return null;
  const strOrNull = (v: unknown) => v === null || typeof v === "string";
  const ok = list.every(
    (r) =>
      typeof r === "object" && r !== null &&
      typeof (r as UndoneRow).id === "string" &&
      strOrNull((r as UndoneRow).prior_release_medium) &&
      strOrNull((r as UndoneRow).prior_released_at) &&
      strOrNull((r as UndoneRow).report_id),
  );
  const skippedOk = skipped.every(
    (r) => typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string",
  );
  if (!ok || !skippedOk) return null;
  return { undone: list as UndoneRow[], skippedIds: (skipped as Array<{ id: string }>).map((r) => r.id) };
}

// The body of undo-release, shared by undoReleaseSelectedAction,
// undoReleaseBatchAction and deleteSampleVisitAction so every undo reverts
// results through the same database function (and so the same 0110
// accounting reversal) and per-row audit. The caller has already validated
// input and owns revalidation; the deleted-visit check lives HERE
// (query-surfaces.test.ts looks for it in this function). `auditExtra` is
// merged into each row's audit metadata. `expectedReleasedAtOf`
// (undoReleaseBatchAction only) limits the undo to the EXACT release each id's
// audit row recorded, whole reports included; every other caller omits it.
async function undoReleasedRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: Awaited<ReturnType<typeof requireActiveStaff>>,
  visitId: string,
  testRequestIds: string[],
  trimmedReason: string,
  auditExtra: Record<string, string | boolean>,
  expectedReleasedAtOf?: ReadonlyMap<string, string>,
): Promise<UndoRowsResult> {
  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  // 0172 / 0198: undo-release is WHOLE-REPORT, decided by the database.
  // undo_visit_release expands the selection to every member of any combined
  // (chemistry) result it touches, refuses the WHOLE request (P0081, message
  // passes through translatePgError) when a member is outside the caller's
  // sections, a package header or on another visit, and reverts only live,
  // released, non-header lines — under the same locks as release, so a
  // concurrent release can never leave one report half undone. Headers only
  // ever flip through the 0110 cascade, never directly. The release times
  // are compared in SQL: a JavaScript Date would drop their microseconds.
  const { data, error } = await withLifecycleRetry(() =>
    supabase.rpc("undo_visit_release", {
      p_visit_id: visitId,
      p_test_request_ids: testRequestIds,
      p_actor: session.user_id,
      p_expected_released_at: expectedReleasedAtOf
        ? Object.fromEntries(expectedReleasedAtOf)
        : null,
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };
  const parsed = parseUndoResult(data);
  if (parsed === null) {
    // The call may have committed: don't guess, send the operator to the page.
    await reportError({
      scope: "release/undo-visit-release-malformed",
      error: new Error("undo_visit_release returned an unexpected shape"),
      metadata: { visit_id: visitId, test_request_ids: testRequestIds },
    });
    return { ok: false, error: COULDNT_CONFIRM_UNDO };
  }
  const { undone, skippedIds } = parsed;
  // A batch Undo may legitimately restore nothing (every report changed since).
  if (undone.length === 0 && !expectedReleasedAtOf) {
    return { ok: false, error: "None of the selected tests can be unreleased." };
  }

  // Snapshot how often the patient had already viewed/downloaded each result
  // at the moment of undo — the undone-releases report surfaces this (RA
  // 10173: undoing does not un-see a result the patient already opened).
  const viewedCountById = new Map<string, number>(
    await Promise.all(
      undone.map(async (row) => [row.id, await countResultViews(row.id)] as const),
    ),
  );

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  for (const row of undone) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.release_undone",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        reason: trimmedReason,
        // Read under the row lock by the RPC, so they describe the release actually undone.
        prior_release_medium: row.prior_release_medium,
        prior_released_at: row.prior_released_at,
        viewed_count: viewedCountById.get(row.id) ?? 0,
        ...auditExtra,
        // Present only when this row was reverted as part of a whole-report
        // undo (0172) — the combined result every member shares.
        report_result_id: row.report_id,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return { ok: true, undoneIds: undone.map((r) => r.id), skippedIds };
}

// Admin-only: delete a visit that was only ever a sample/test entry, even
// though some of its results were released. A released result blocks a
// visit delete (P0043), so by hand this is two steps — undo every release,
// then Delete. This does both, in that order, through the same code paths:
// undoReleasedRows (0110 reverses each row's journal entry; each row is
// audit-logged as test_request.release_undone, tagged sample_visit_delete)
// and deleteVisitAction (the 0125 guard triggers still decide; the visit is
// restorable afterwards). Every OTHER delete blocker still applies — active
// payments, a waived balance, an open HMO claim — because those are money,
// and the sample label does not make them go away.
//
// Not atomic: if the delete fails after the undo, the results stay
// unreleased and the error says so; running it again finishes the job.
export async function deleteSampleVisitAction(
  visitId: string,
  reason: string,
): Promise<BulkSelectionResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false, error: "Only an admin can delete a sample visit." };
  }
  const parsed = QueueDeleteReasonSchema.safeParse({ reason });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Reason is required.",
    };
  }
  const trimmedReason = parsed.data.reason;

  const supabase = await createClient();
  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .select(
      "id, payment_status, deleted_at, test_requests ( id, status, is_package_header, deleted_at, hmo_claim_items ( batch_voided ) )",
    )
    .eq("id", visitId)
    .maybeSingle();
  if (visitErr) return { ok: false, error: translatePgError(visitErr) };
  if (!visit) return { ok: false, error: "Visit not found." };

  const lines = visit.test_requests ?? [];
  const liveLines = lines.filter((t) => t.deleted_at === null);
  // Every delete rule except "released" — that one is what this action
  // exists to clear. The HMO check runs over ALL lines, deleted included,
  // exactly as the page and the P0050 trigger do.
  const gate = visitDeletability(
    session.role,
    withoutReleased({
      payment_status: visit.payment_status,
      deleted_at: visit.deleted_at,
      test_statuses: liveLines.map((t) => t.status),
      has_open_hmo_claim: lines.some((t) => hasOpenHmoClaim(t.hmo_claim_items)),
    }),
  );
  if (!gate.ok) return { ok: false, error: gate.hint };

  // Headers are left out on purpose, as in undoReleaseSelectedAction: a
  // header only ever flips back through the 0110 cascade when its last
  // released component is undone.
  const releasedIds = liveLines
    .filter((t) => t.status === "released" && !t.is_package_header)
    .map((t) => t.id);

  let unreleased = 0;
  if (releasedIds.length > 0) {
    const undo = await undoReleasedRows(
      supabase,
      session,
      visitId,
      releasedIds,
      `Sample visit deleted: ${trimmedReason}`,
      { bulk: true, sample_visit_delete: true },
    );
    if (!undo.ok) {
      revalidateReleaseSurfaces(visitId);
      return { ok: false, error: undo.error };
    }
    unreleased = undo.undoneIds.length;
  }

  const deleted = await deleteVisitAction(
    visitId,
    `Sample visit: ${trimmedReason}`.slice(0, 500),
  );
  if (!deleted.ok) {
    revalidateReleaseSurfaces(visitId);
    return {
      ok: false,
      error:
        unreleased > 0
          ? `${unreleased} result${unreleased === 1 ? " was" : "s were"} unreleased, but the visit was not deleted: ${deleted.error}`
          : deleted.error,
    };
  }
  // deleteVisitAction refreshes the queue lists; the deleted visit (and any
  // release undone above) also changes the dashboard tiles and the queue
  // report pages, even when nothing had been released.
  revalidateReleaseSurfaces(visitId);
  return { ok: true, count: unreleased };
}

// H3: admin-only escape hatch for visits that will never be cash-paid
// (HMO-covered, charity, no-charge). Setting payment_status = 'waived'
// happens inside waive_visit_balance() (0183), which also fixes the waiver,
// allocates it per line, books the discount and clears 1100; the P0069/P0070
// guards then freeze the visit's money and lines.
export async function waiveVisitBalanceAction(
  visitId: string,
  reason: string,
): Promise<ReleaseResult> {
  const parsed = WaiveBalanceSchema.safeParse({ reason });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Reason is required." };
  }
  const session = await requireAdminStaff();

  const admin = createAdminClient();

  // 0167: waiving is a financial change — refuse it on an inactive record.
  const active = await assertVisitPatientActive(admin, visitId);
  if (!active.ok) return { ok: false, error: active.error };

  // 0183: the RPC owns every rule (admin actor, non-HMO, unpaid/partial,
  // provenance, the per-line split, the discount JE) under the visit + line
  // row locks, and raises P0071 with a staff-readable message per refusal.
  // 0184: waive_visit_balance takes the patient lifecycle lock LAST, at its
  // visits UPDATE — a concurrent ownership move can make it a 40P01 victim,
  // so retry once (a single RPC call, rolled back whole on loss).
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("waive_visit_balance", {
      p_visit_id: visitId,
      p_actor_id: session.user_id,
      p_reason: parsed.data.reason,
    }),
  );
  if (error) {
    revalidateReleaseSurfaces(visitId);
    return {
      ok: false,
      error: error.code === "P0002" ? WAIVE_CLOSED_MONTH_MESSAGE : translatePgError(error),
    };
  }
  const result = (data ?? {}) as {
    waived_php?: number;
    allocations?: number;
    posted_now?: number;
    legacy?: boolean;
    previous_status?: string;
    headers_pending?: number;
  };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.waived",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      reason: parsed.data.reason,
      previous_status: result.previous_status ?? null,
      balance_waived_php: result.waived_php ?? null,
      // 0183: how the remainder reached the books.
      allocations: result.allocations ?? 0,
      posted_now: result.posted_now ?? 0,
      legacy: result.legacy ?? false,
      // A package header the waive could not auto-release (closed month):
      // it stays ready_for_release and folds when released by hand.
      headers_pending: result.headers_pending ?? 0,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateReleaseSurfaces(visitId);
  return { ok: true };
}

// Both doctor kinds skip the lab queue and go straight from
// requested/in_progress to released — there's no result to upload, and
// releasing is what fires PF accrual (bridge_test_request_released branches
// on kind in ('doctor_consultation','doctor_procedure') identically).
type DoctorLineKind = "doctor_consultation" | "doctor_procedure";

// Everything that varies by kind, in one place — a future third wrapper
// only has to add an entry here, not pass a hand-matched string triple.
const KIND_COPY: Record<
  DoctorLineKind,
  {
    wrongKindError: string;
    auditAction: "consultation.completed" | "procedure.completed";
    notPendingError: string;
  }
> = {
  doctor_consultation: {
    wrongKindError: "This action is only for consultations.",
    auditAction: "consultation.completed",
    notPendingError: "This consultation is no longer pending.",
  },
  doctor_procedure: {
    wrongKindError: "This action is only for procedures.",
    auditAction: "procedure.completed",
    notPendingError: "This procedure is no longer pending.",
  },
};

async function markDoctorLineDoneAction(
  testRequestId: string,
  visitId: string,
  expectedKind: DoctorLineKind,
): Promise<ReleaseResult> {
  const { wrongKindError, auditAction, notPendingError } = KIND_COPY[expectedKind];
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  // Guard server-side so a future/mis-wired caller can't release another kind.
  const { data: tr } = await supabase
    .from("test_requests")
    .select("id, services!inner ( kind, section, name )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  const svc = Array.isArray(tr?.services) ? tr?.services[0] : tr?.services;
  if (!tr || svc?.kind !== expectedKind) {
    return { ok: false, error: wrongKindError };
  }

  // Doctor lines are admin/pathologist-only. Their services carry a null
  // section, which scopeToAllowedSections passes only for an unrestricted
  // (null) role list — the same rule that hides them from medtech, xray and
  // reception on the visit page. Enforced here because every export of this
  // "use server" module is a callable endpoint.
  const allowedSections = sectionsForRole(session.role);
  if (scopeToAllowedSections([tr], allowedSections).length === 0) {
    return {
      ok: false,
      error:
        "Only an admin or pathologist can mark a consultation or procedure done.",
    };
  }

  const now = new Date().toISOString();

  const { error, data: updated } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: "other",
    })
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    // `ready_for_release` is reachable for a doctor line only through
    // undoReleaseSelectedAction, which is kind-agnostic by design (undoing a
    // mistakenly-completed consultation is legitimate). Re-completing it has
    // to come back through THIS action: the generic Release button would fire
    // notifyResultReleased and email the patient about a lab result that does
    // not exist. Accepting the status here is what lets the visit page offer
    // "Mark done" for it instead.
    .in("status", ["requested", "in_progress", "ready_for_release"])
    .select("id");

  if (error) {
    // Payment gate (visit not paid) or P0034 (line has no attending
    // physician) → friendly text.
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated || updated.length === 0) {
    // 0 rows matched — a concurrent action (e.g. a bulk package release)
    // already completed it. Never audit a write that didn't happen.
    revalidateReleaseSurfaces(visitId);
    return { ok: false, error: notPendingError };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: auditAction,
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidateReleaseSurfaces(visitId);
  return { ok: true };
}

export async function markConsultationDoneAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  return markDoctorLineDoneAction(testRequestId, visitId, "doctor_consultation");
}

export async function markProcedureDoneAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  return markDoctorLineDoneAction(testRequestId, visitId, "doctor_procedure");
}
