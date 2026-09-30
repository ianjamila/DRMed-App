"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
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
import {
  expandUndoReleaseScope,
  groupIdsByExpectedReleasedAt,
  reportsToRefuse,
  undoUpdateIds,
  type UndoReleaseScopeExpansion,
  type UndoScopeMemberRow,
  type UndoScopeRejectionReason,
} from "@/lib/visits/undo-release-scope";


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

// User-facing text for expandUndoReleaseScope's rejections (0172). The whole
// request is refused — no partial undo — so each message explains why
// nothing happened rather than which row was the problem.
const UNDO_SCOPE_REJECTION_MESSAGE: Record<UndoScopeRejectionReason, string> = {
  outside_sections:
    "This report has tests outside the sections you can act on, so it can't be undone from here — ask an admin.",
  package_header:
    "This report includes a package header, which shouldn't happen — ask an admin to check it.",
  other_visit:
    "This report spans more than one visit, which shouldn't happen — ask an admin to check it.",
};

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
    return { ok: false, error: "No components are ready to release." };
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
    return { ok: false, error: "None of the selected tests are ready to release." };
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
    notifiedCount: await notifiedCount(supabase, visitId, releaseMedium, out.announced.length),
  };
}

// How many released tests the patient was actually sent a notice about, for
// the bar's "already notified" line. 0 for a report withheld as unverified
// (not in `announced`), for a physical / pickup hand-off (notify-released
// M7) and for a sample visit (SAMPLE_SKIP_REASON) — none of those message the
// patient. A failed sample read counts as notified: the line then errs on
// telling staff to inform the patient.
async function notifiedCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  visitId: string,
  medium: ReleaseMedium,
  announced: number,
): Promise<number> {
  if (announced === 0 || medium === "physical" || medium === "pickup") return 0;
  const { data } = await supabase
    .from("visits")
    .select("is_sample")
    .eq("id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  return data?.is_sample === true ? 0 : announced;
}

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
  // in it), regardless of changedSince — reportsToRefuse needs the full set
  // to tell "a report member this batch never released" apart from "one of
  // ours that changed since" (Finding 4, P1).
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
  // releaseRows always stamps visit_id — a batch with none of its
  // rows carrying it is not a batch this action wrote.
  if (!visitId) return { ok: false, error: UNDO_EXPIRED };
  if (candidateIds.length === 0) {
    return notRestored.length > 0
      ? { ok: true, restoredIds: [], notRestored }
      : { ok: false, error: UNDO_EXPIRED };
  }

  const supabase = await createClient();

  // Finding 4 (P1): combined reports are all-or-nothing (owner rule), but the
  // shared core (undoReleasedRows) expands ANY selected member to the WHOLE
  // report regardless of the other members' provenance — so a member this
  // batch never released, or one already rejected above as changed-since,
  // would otherwise be pulled back in by the expansion, and its warning would
  // be silently dropped by the restoredSet filter below. So: before handing
  // candidateIds to the core, expand them to whole-report membership
  // ourselves (same reads/expandUndoReleaseScope the core uses, via the
  // shared loadReportExpansion) and refuse the WHOLE report — every member
  // added to notRestored, none passed to the core — when any member is
  // changed-since or was not released by this exact batch. Standalone
  // (non-report) ids are untouched by this and keep today's per-row rule.
  // A read/validation failure here fails CLOSED (refuses the whole undo)
  // rather than silently falling through to the core's unfiltered expansion.
  const allowedSections = sectionsForRole(session.role);
  const expansionResult = await loadReportExpansion(
    supabase,
    candidateIds,
    visitId,
    allowedSections,
  );
  if (!expansionResult.ok) return { ok: false, error: expansionResult.error };

  const refusedReportIds = reportsToRefuse({
    reportResultIdByTestRequestId: expansionResult.expansion.reportResultIdByTestRequestId,
    batchReleasedIds,
    changedSinceIds: loaded.changedSince,
  });
  let scopedCandidateIds = candidateIds;
  if (refusedReportIds.size > 0) {
    scopedCandidateIds = candidateIds.filter((id) => !refusedReportIds.has(id));
    for (const id of refusedReportIds) {
      // Name only tests THIS batch released — a report member released
      // separately is why the report was refused, not one of the actor's own
      // rows, and counting it would inflate "Not undone (N)".
      if (!batchReleasedIds.has(id)) continue;
      if (!notRestored.some((n) => n.id === id)) {
        notRestored.push({ id, reason: CHANGED_SINCE_REASON });
      }
    }
  }
  // Defensive: every id reaching here came from a `test_request.released` row
  // this SAME batch wrote, which always stamps `released_at` (see
  // releaseRows) — so this only fires for a row whose audit row somehow
  // lacks it. Refuse it rather
  // than silently drop it from both restoredIds and notRestored (rule: a
  // rejected member's warning must never be dropped).
  const withoutReleaseIdentity = scopedCandidateIds.filter((id) => !expectedReleasedAtOf.has(id));
  if (withoutReleaseIdentity.length > 0) {
    scopedCandidateIds = scopedCandidateIds.filter((id) => expectedReleasedAtOf.has(id));
    for (const id of withoutReleaseIdentity) {
      if (!notRestored.some((n) => n.id === id)) {
        notRestored.push({ id, reason: CHANGED_SINCE_REASON });
      }
    }
  }
  if (scopedCandidateIds.length === 0) {
    return notRestored.length > 0
      ? { ok: true, restoredIds: [], notRestored }
      : { ok: false, error: UNDO_EXPIRED };
  }

  const undoBatchId = crypto.randomUUID();
  const result = await undoReleasedRows(
    supabase,
    session,
    visitId,
    scopedCandidateIds,
    "Undone within 10 minutes of release",
    {
      bulk: true,
      via: BULK_UNDO_VIA,
      undo_of_batch: parsed.data.batchId,
      bulk_batch_id: undoBatchId,
    },
    expectedReleasedAtOf,
  );
  // The Queue's Pending release tab and the dashboard cards list ready
  // work too (#261), so refresh every release surface, as Unrelease does.
  revalidateReleaseSurfaces(visitId);
  if (!result.ok) return { ok: false, error: result.error };

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
  | { ok: true; undoneIds: string[] }
  | { ok: false; error: string };

type ReportExpansionResult =
  | { ok: true; expansion: UndoReleaseScopeExpansion }
  | { ok: false; error: string };

// 0172 / PR 2 §5, §9 R4: undo-release is WHOLE-REPORT. Expand a selection to
// every member of any combined (chemistry) result it touches — regardless of
// that member's own status — before scoping/updating, so a partially-released
// or legacy report is undone as a whole rather than splitting one report
// across two statuses. Two batched queries, no N+1: which results the
// selection links to, then every member of those results.
// expandUndoReleaseScope rejects the WHOLE request (no partial undo) when a
// member is outside the caller's sections, a package header, or on another
// visit — the server expansion is authoritative; any client wording of the
// scope is display only. Fail closed: a read error must not silently shrink
// the undo to a partial report. Shared by undoReleasedRows (below) and
// undoReleaseBatchAction's Finding-4 pre-check, so both see the SAME
// membership for the same ids rather than two independently-drifting reads.
async function loadReportExpansion(
  supabase: Awaited<ReturnType<typeof createClient>>,
  testRequestIds: string[],
  visitId: string,
  allowedSections: readonly string[] | null,
): Promise<ReportExpansionResult> {
  const { data: initialLinks, error: linkErr } = await supabase
    .from("result_test_requests")
    .select("test_request_id, result_id")
    .in("test_request_id", testRequestIds);
  if (linkErr) return { ok: false, error: translatePgError(linkErr) };
  const touchedResultIds = Array.from(
    new Set((initialLinks ?? []).map((l) => l.result_id)),
  );

  let scopeMembers: UndoScopeMemberRow[] = [];
  if (touchedResultIds.length > 0) {
    const { data: memberLinks, error: memberErr } = await supabase
      .from("result_test_requests")
      .select(
        "test_request_id, result_id, test_requests!inner ( visit_id, is_package_header, services!inner ( section ) )",
      )
      .in("result_id", touchedResultIds);
    if (memberErr) return { ok: false, error: translatePgError(memberErr) };
    scopeMembers = (memberLinks ?? []).map((l) => {
      const tr = Array.isArray(l.test_requests) ? l.test_requests[0] : l.test_requests;
      const svc = tr ? (Array.isArray(tr.services) ? tr.services[0] : tr.services) : null;
      return {
        testRequestId: l.test_request_id,
        resultId: l.result_id,
        visitId: tr?.visit_id ?? "",
        isPackageHeader: tr?.is_package_header ?? false,
        section: svc?.section ?? null,
      };
    });
  }

  const expansion = expandUndoReleaseScope({
    selectedIds: testRequestIds,
    members: scopeMembers,
    visitId,
    allowedSections,
  });
  if (!expansion.ok) {
    return { ok: false, error: UNDO_SCOPE_REJECTION_MESSAGE[expansion.reason] };
  }
  return { ok: true, expansion };
}

// The body of undo-release, shared by undoReleaseSelectedAction and
// deleteSampleVisitAction so a sample-visit delete reverts results through
// exactly the same scope expansion, status-filtered UPDATE (and so the same
// 0110 accounting reversal) and per-row audit as a hand-picked undo. The
// caller has already validated input and owns revalidation; the deleted-visit
// check lives HERE, next to the line reads it protects (query-surfaces.test.ts
// looks for it in this function). `auditExtra` is merged into each row's
// audit metadata. `expectedReleasedAtOf` (undoReleaseBatchAction only) scopes
// the final UPDATE to the EXACT release each id's audit row recorded — see
// the write below; when omitted (every other caller), behaviour is
// byte-for-byte what it was before Finding 4's fix.
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

  const allowedSections = sectionsForRole(session.role);

  const expansionResult = await loadReportExpansion(
    supabase,
    testRequestIds,
    visitId,
    allowedSections,
  );
  if (!expansionResult.ok) return { ok: false, error: expansionResult.error };
  const expandedIds = expansionResult.expansion.expandedIds;
  const reportResultIdByTestRequestId =
    expansionResult.expansion.reportResultIdByTestRequestId;

  // is_package_header = false is LOAD-BEARING, not a convenience filter:
  // nothing at the DB layer blocks a direct header released→ready_for_release
  // transition, and that state (header ready, components released) would let
  // a later payment-status change silently re-release the header with a
  // fresh JE. Headers must only ever flip via the 0110 cascade (triggered by
  // undoing their last released component), never by being selected here
  // directly.
  const { data: candidates } = await supabase
    .from("test_requests")
    .select("id, release_medium, released_at, services!inner ( section, name )")
    .in("id", expandedIds)
    .eq("visit_id", visitId)
    .eq("status", "released")
    .eq("is_package_header", false)
    .is("deleted_at", null);

  const scoped = scopeToAllowedSections(candidates ?? [], allowedSections);
  if (scoped.length === 0) {
    return { ok: false, error: "None of the selected tests can be unreleased." };
  }
  const scopedIds = scoped.map((r) => r.id);
  // TOCTOU note: prior_release_medium / prior_released_at are read one
  // round-trip before the UPDATE below. If another actor undoes AND
  // re-releases a row inside that window, these audit metadata fields record
  // the earlier release. Accepted trade-off — the undo event itself is always
  // real (the UPDATE is status-filtered) and the DB trigger's accounting
  // reversal is transaction-correct; closing it fully would need an atomic
  // RPC.
  const priorById = new Map(
    (candidates ?? []).map((r) => [
      r.id,
      { release_medium: r.release_medium, released_at: r.released_at },
    ]),
  );
  // Snapshot how often the patient had already viewed/downloaded each result
  // at the moment of undo — the undone-releases report surfaces this (RA
  // 10173: undoing does not un-see a result the patient already opened).
  const viewedCountById = new Map<string, number>(
    await Promise.all(
      scopedIds.map(
        async (trId) => [trId, await countResultViews(trId)] as const,
      ),
    ),
  );

  // Whole-report undo [R4]: every member of an expanded report goes to the
  // UPDATE, not only the ones observed as released a round trip ago — a
  // member released in between would otherwise stay released while the rest
  // of its report is undone. The expansion above already proved every such
  // member is in the caller's sections, on this visit and not a header; the
  // status filter decides which rows actually revert.
  const updateIds = undoUpdateIds(scopedIds, reportResultIdByTestRequestId.keys());

  const UNRELEASE_PATCH = {
    status: "ready_for_release" as const,
    released_at: null,
    released_by: null,
    release_medium: null,
  };
  let undone: Array<{ id: string }> | null;
  let error: { code?: string; message?: string; details?: string } | null;
  if (expectedReleasedAtOf && expectedReleasedAtOf.size > 0) {
    // Finding 4 (P1): scope the write to the EXACT release this batch wrote,
    // not merely "still released" — a row unreleased and re-released by
    // someone else inside the Undo window must not come back. Group by
    // distinct released_at (a report's members share one, since
    // releaseRows stamps every row of one release with the same `releasedAt`) and issue
    // one UPDATE per group; ids with no recorded released_at are refused
    // (excluded from every write, never matched) rather than restored on a
    // guess.
    const { groups } = groupIdsByExpectedReleasedAt(updateIds, expectedReleasedAtOf);
    const rows: Array<{ id: string }> = [];
    error = null;
    for (const group of groups) {
      const { data, error: groupError } = await supabase
        .from("test_requests")
        .update(UNRELEASE_PATCH)
        .in("id", group.ids)
        .eq("visit_id", visitId)
        .eq("status", "released")
        .eq("is_package_header", false)
        .is("deleted_at", null)
        .eq("released_at", group.releasedAt)
        .select("id");
      if (groupError) {
        error = groupError;
        break;
      }
      rows.push(...(data ?? []));
    }
    undone = error ? null : rows;
  } else {
    const result = await supabase
      .from("test_requests")
      .update(UNRELEASE_PATCH)
      .in("id", updateIds)
      .eq("visit_id", visitId)
      .eq("status", "released")
      .eq("is_package_header", false)
      .is("deleted_at", null)
      .select("id");
    undone = result.data;
    error = result.error;
  }

  if (error) return { ok: false, error: translatePgError(error) };
  if (!undone || undone.length === 0) {
    return { ok: false, error: "None of the selected tests can be unreleased." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  // A member released after the candidate read has no snapshot yet.
  for (const row of undone) {
    if (!viewedCountById.has(row.id)) {
      viewedCountById.set(row.id, await countResultViews(row.id));
    }
  }
  for (const row of undone) {
    const prior = priorById.get(row.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.release_undone",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        reason: trimmedReason,
        prior_release_medium: prior?.release_medium ?? null,
        prior_released_at: prior?.released_at ?? null,
        viewed_count: viewedCountById.get(row.id) ?? 0,
        ...auditExtra,
        // Present only when this row was reverted as part of a whole-report
        // undo (0172) — the combined result every member shares.
        report_result_id: reportResultIdByTestRequestId.get(row.id) ?? null,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return { ok: true, undoneIds: undone.map((r) => r.id) };
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
      revalidatePath(`/staff/visits/${visitId}`);
      return { ok: false, error: undo.error };
    }
    unreleased = undo.undoneIds.length;
  }

  const deleted = await deleteVisitAction(
    visitId,
    `Sample visit: ${trimmedReason}`.slice(0, 500),
  );
  if (!deleted.ok) {
    revalidatePath(`/staff/visits/${visitId}`);
    return {
      ok: false,
      error:
        unreleased > 0
          ? `${unreleased} result${unreleased === 1 ? " was" : "s were"} unreleased, but the visit was not deleted: ${deleted.error}`
          : deleted.error,
    };
  }
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
  const { data, error } = await admin.rpc("waive_visit_balance", {
    p_visit_id: visitId,
    p_actor_id: session.user_id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    revalidatePath(`/staff/visits/${visitId}`);
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

  revalidatePath(`/staff/visits/${visitId}`);
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
    revalidatePath(`/staff/visits/${visitId}`);
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

  revalidatePath(`/staff/visits/${visitId}`);
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
