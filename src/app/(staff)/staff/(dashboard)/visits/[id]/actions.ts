"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import { ipAndAgent } from "@/lib/server/action-helpers";
import {
  QueueDeleteReasonSchema,
  WaiveBalanceSchema,
} from "@/lib/validations/accounting";
import { deleteVisitAction } from "@/lib/actions/visits/queue-deletion";
import {
  hasOpenHmoClaim,
  visitDeletability,
  withoutReleased,
} from "@/lib/visits/deletion";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { notifyResultsReleasedBulk } from "@/lib/notifications/notify-released-bulk";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reportError } from "@/lib/observability/report-error";
import {
  MAX_BULK_SELECTION,
  scopeToAllowedSections,
} from "@/lib/visits/bulk-selection";
import { countResultViews } from "@/lib/results/viewed-count";
import { canManuallyReleasePackageHeader } from "@/lib/visits/package-header-release";
import {
  expandUndoReleaseScope,
  undoUpdateIds,
  type UndoScopeMemberRow,
  type UndoScopeRejectionReason,
} from "@/lib/visits/undo-release-scope";

export type ReleaseMedium =
  | "physical"
  | "email"
  | "viber"
  | "gcash"
  | "pickup"
  | "other";

export type ReleaseResult =
  | { ok: true }
  | { ok: false; error: string };

// Bulk-selection actions additionally report how many rows the UPDATE
// actually touched, so the UI can tell the user when part of the selection
// was skipped (already handled by a concurrent action, or outside the
// caller's section scope). Local to releaseSelectedAction /
// undoReleaseSelectedAction — the older per-row/per-package actions keep the
// plain ReleaseResult shape.
export type BulkSelectionResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

const VALID_MEDIA: readonly ReleaseMedium[] = [
  "physical",
  "email",
  "viber",
  "gcash",
  "pickup",
  "other",
];

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

export async function releaseTestAction(
  testRequestId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<ReleaseResult> {
  if (!VALID_MEDIA.includes(releaseMedium)) {
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
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "This result is no longer ready to release." };
  }
  if (scopeToAllowedSections([candidate], allowedSections).length === 0) {
    return {
      ok: false,
      error: "This test is outside the sections you can release.",
    };
  }

  const now = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
    })
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .select("id");

  if (error) {
    // The payment-gating and consent-gating triggers raise check_violation
    // (23514). translatePgError turns both into friendly, gate-specific text.
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated || updated.length === 0) {
    // 0 rows matched — a concurrent action (e.g. a bulk package release)
    // already released it. Never audit or notify a write that didn't happen.
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "This result is no longer ready to release." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.released",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId, release_medium: releaseMedium },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Fire-and-forget notification. Failures are audit-logged inside, never
  // bubble up — release is the source of truth.
  try {
    await notifyResultReleased({ testRequestId, visitId, releaseMedium });
  } catch (err) {
    await reportError({
      scope: "notify/result-released",
      error: err,
      metadata: { test_request_id: testRequestId },
    });
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}

// Flattens the `services ( name )` embed (Supabase returns an array or a
// single object depending on the join shape) into the plain service name.
function serviceName(
  services: { name: string } | { name: string }[] | null,
): string | null {
  const svc = Array.isArray(services) ? services[0] : services;
  return svc?.name ?? null;
}

// Releases every component of a package that's ready (payment + consent
// gates already cleared per-row) in a single UPDATE. The package header is
// NOT touched here — migration 0109's Leg A trigger auto-releases it once
// the last component goes terminal on a paid visit.
export async function releaseAllReadyComponentsAction(
  headerId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<ReleaseResult> {
  if (!VALID_MEDIA.includes(releaseMedium)) {
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
  let scopedIds: string[] | null = null;
  if (allowedSections !== null) {
    const { data: readyRows } = await supabase
      .from("test_requests")
      .select("id, services!inner ( section )")
      .eq("parent_id", headerId)
      .eq("visit_id", visitId)
      .eq("status", "ready_for_release")
      .is("deleted_at", null);
    scopedIds = (readyRows ?? [])
      .filter((r) => {
        const svc = Array.isArray(r.services) ? r.services[0] : r.services;
        const sect = svc?.section ?? null;
        return sect != null && allowedSections.includes(sect as never);
      })
      .map((r) => r.id);
    if (scopedIds.length === 0) {
      revalidatePath(`/staff/visits/${visitId}`);
      return { ok: false, error: "No components are ready to release." };
    }
  }

  const now = new Date().toISOString();
  // Single user-scoped UPDATE: per-row payment/consent triggers still enforce
  // the gates; the header then auto-releases via the Leg A trigger. The
  // parent_id/visit_id/status filters stay on even when section-scoped by
  // id — they keep the update race-safe against concurrent releases.
  let updateQuery = supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
    })
    .eq("parent_id", headerId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release");
  if (scopedIds !== null) {
    updateQuery = updateQuery.in("id", scopedIds);
  }
  const { data: released, error } = await updateQuery.select(
    "id, services ( name )",
  );

  if (error) return { ok: false, error: translatePgError(error) };
  if (!released || released.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "No components are ready to release." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  // One audit row per released component (per-release convention), bulk-tagged.
  for (const row of released) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.released",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: visitId, release_medium: releaseMedium, bulk: true },
      ip_address: ip,
      user_agent: ua,
    });
  }

  // S2: ONE consolidated notification for the whole bulk action.
  try {
    await notifyResultsReleasedBulk({
      visitId,
      testRequestIds: released.map((r) => r.id),
      testNames: released.map((r) => serviceName(r.services) ?? "Result"),
      releaseMedium,
    });
  } catch (err) {
    await reportError({
      scope: "notify/result-released-bulk",
      error: err,
      metadata: { visit_id: visitId, header_id: headerId },
    });
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
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
    revalidatePath(`/staff/visits/${visitId}`);
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

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}

// Releases a hand-picked selection of ready components/standalone tests in a
// single UPDATE. Mirrors releaseAllReadyComponentsAction's hardening but
// operates over an arbitrary caller-supplied id list instead of "all
// components under one header." Package headers are never included in the
// selection (is_package_header = false is part of the pre-SELECT filter) —
// if a selection happens to complete a package, migration 0109's Leg A
// trigger auto-releases the header exactly as it does for the existing bulk
// action.
export async function releaseSelectedAction(
  visitId: string,
  testRequestIds: string[],
  releaseMedium: ReleaseMedium,
): Promise<BulkSelectionResult> {
  if (!VALID_MEDIA.includes(releaseMedium)) {
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

  const allowedSections = sectionsForRole(session.role);
  const { data: candidates } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name )")
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .eq("is_package_header", false)
    .is("deleted_at", null);

  const scoped = scopeToAllowedSections(candidates ?? [], allowedSections);
  if (scoped.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "None of the selected tests are ready to release." };
  }
  const scopedIds = scoped.map((r) => r.id);

  const now = new Date().toISOString();
  const { data: released, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
    })
    .in("id", scopedIds)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .select("id, services ( name )");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!released || released.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "None of the selected tests are ready to release." };
  }

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
        release_medium: releaseMedium,
        bulk: true,
        selection: true,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  try {
    if (released.length === 1) {
      await notifyResultReleased({
        testRequestId: released[0].id,
        visitId,
        releaseMedium,
      });
    } else {
      await notifyResultsReleasedBulk({
        visitId,
        testRequestIds: released.map((r) => r.id),
        testNames: released.map((r) => serviceName(r.services) ?? "Result"),
        releaseMedium,
      });
    }
  } catch (err) {
    await reportError({
      scope: "notify/result-released-selection",
      error: err,
      metadata: { visit_id: visitId, test_request_ids: released.map((r) => r.id) },
    });
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true, count: released.length };
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
  revalidatePath(`/staff/visits/${visitId}`);
  return result.ok ? { ok: true, count: result.undoneIds.length } : result;
}

type UndoRowsResult =
  | { ok: true; undoneIds: string[] }
  | { ok: false; error: string };

// The body of undo-release, shared by undoReleaseSelectedAction and
// deleteSampleVisitAction so a sample-visit delete reverts results through
// exactly the same scope expansion, status-filtered UPDATE (and so the same
// 0110 accounting reversal) and per-row audit as a hand-picked undo. The
// caller has already validated input and owns revalidation; the deleted-visit
// check lives HERE, next to the line reads it protects (query-surfaces.test.ts
// looks for it in this function). `auditExtra` is merged into each row's
// audit metadata.
async function undoReleasedRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: Awaited<ReturnType<typeof requireActiveStaff>>,
  visitId: string,
  testRequestIds: string[],
  trimmedReason: string,
  auditExtra: Record<string, boolean>,
): Promise<UndoRowsResult> {
  const visitDeleted = await refuseIfVisitDeleted(supabase, visitId);
  if (visitDeleted) return visitDeleted;

  const allowedSections = sectionsForRole(session.role);

  // 0172 / PR 2 §5, §9 R4: undo-release is WHOLE-REPORT. Expand the caller's
  // selection to every member of any combined (chemistry) result it touches
  // — regardless of that member's own status — before scoping/updating, so a
  // partially-released or legacy report is undone as a whole rather than
  // splitting one report across two statuses. Two batched queries, no N+1:
  // which results the selection links to, then every member of those
  // results. expandUndoReleaseScope rejects the WHOLE request (no partial
  // undo) when a member is outside the caller's sections, a package header,
  // or on another visit — the server expansion is authoritative; any client
  // wording of the scope is display only.
  // Fail closed: a read error must not silently shrink the undo to a partial
  // report.
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
  const expandedIds = expansion.expandedIds;
  const reportResultIdByTestRequestId = expansion.reportResultIdByTestRequestId;

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
  const { data: undone, error } = await supabase
    .from("test_requests")
    .update({
      status: "ready_for_release",
      released_at: null,
      released_by: null,
      release_medium: null,
    })
    .in("id", updateIds)
    .eq("visit_id", visitId)
    .eq("status", "released")
    .eq("is_package_header", false)
    .is("deleted_at", null)
    .select("id");

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
// (HMO-covered, charity, no-charge). Setting payment_status = 'waived' is the
// one legitimate manual write to that column — recalc_visit_payment preserves
// 'waived' through every later payment/void, and the 0109 Leg B trigger then
// auto-releases any package header whose components are already terminal.
export async function waiveVisitBalanceAction(
  visitId: string,
  reason: string,
): Promise<ReleaseResult> {
  const parsed = WaiveBalanceSchema.safeParse({ reason });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Reason is required." };
  }
  const session = await requireAdminStaff();
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select("payment_status, total_php, paid_php, deleted_at, hmo_provider_id")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) {
    return { ok: false, error: "Visit not found." };
  }
  if (visit.deleted_at !== null) {
    return {
      ok: false,
      error: "This visit was deleted from the queue. Restore it before waiving.",
    };
  }
  if (visit.hmo_provider_id !== null) {
    // A5: waiving does NOT write off the HMO receivable — the release
    // bridge still books AR-HMO by hmo_provider_id on release regardless of
    // payment_status. Offering "waive" here is a misleading-status trap:
    // an HMO visit already releases without payment (moneySettled's HMO
    // carve-out), so there is nothing waiving would unblock.
    return {
      ok: false,
      error:
        "This visit is billed to an HMO and already releases without payment — there's no balance to waive.",
    };
  }
  if (visit.payment_status === "waived") {
    return { ok: false, error: "This visit's balance is already waived." };
  }
  if (visit.payment_status === "paid") {
    return { ok: false, error: "This visit is already fully paid — nothing to waive." };
  }

  // 0167: waiving is a financial reversal — refuse it on an inactive record
  // (does its own inline check rather than routing through refuseIfVisitDeleted).
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };

  // Status filter keeps the write race-safe: a concurrent payment that flips
  // the visit to 'paid' makes this UPDATE match 0 rows instead of clobbering.
  // The deleted_at filter closes the same race against a concurrent queue
  // delete (0125's P0046 trigger backstops it in the DB).
  const { data: updated, error } = await supabase
    .from("visits")
    .update({ payment_status: "waived" })
    .eq("id", visitId)
    .in("payment_status", ["unpaid", "partial"])
    .is("deleted_at", null)
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "This visit can no longer be waived." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.waived",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      reason: parsed.data.reason,
      previous_status: visit.payment_status,
      balance_waived_php: Number(visit.total_php) - Number(visit.paid_php),
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
