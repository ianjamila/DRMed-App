"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
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
    await notifyResultReleased({ testRequestId, visitId });
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

  // Verify the target really is a package header on this visit.
  const { data: header } = await supabase
    .from("test_requests")
    .select("id, is_package_header, visit_id")
    .eq("id", headerId)
    .eq("visit_id", visitId)
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
      .eq("status", "ready_for_release");
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

  const allowedSections = sectionsForRole(session.role);
  const { data: candidates } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name )")
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .eq("is_package_header", false);

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
      await notifyResultReleased({ testRequestId: released[0].id, visitId });
    } else {
      await notifyResultsReleasedBulk({
        visitId,
        testRequestIds: released.map((r) => r.id),
        testNames: released.map((r) => serviceName(r.services) ?? "Result"),
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

  const allowedSections = sectionsForRole(session.role);
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
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .eq("status", "released")
    .eq("is_package_header", false);

  const scoped = scopeToAllowedSections(candidates ?? [], allowedSections);
  if (scoped.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
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

  const { data: undone, error } = await supabase
    .from("test_requests")
    .update({
      status: "ready_for_release",
      released_at: null,
      released_by: null,
      release_medium: null,
    })
    .in("id", scopedIds)
    .eq("visit_id", visitId)
    .eq("status", "released")
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!undone || undone.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "None of the selected tests can be unreleased." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
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
        bulk: true,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true, count: undone.length };
}

export async function markConsultationDoneAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // This action is only for consultation lines — releasing fires PF accrual.
  // Guard server-side so a future/mis-wired caller can't release another kind.
  const { data: tr } = await supabase
    .from("test_requests")
    .select("services ( kind )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .maybeSingle();
  const svc = Array.isArray(tr?.services) ? tr?.services[0] : tr?.services;
  if (!tr || svc?.kind !== "doctor_consultation") {
    return { ok: false, error: "This action is only for consultations." };
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
    .in("status", ["requested", "in_progress"])
    .select("id");

  if (error) {
    // Payment gate (visit not paid) or P0034 (consult has no attending
    // physician) → friendly text.
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated || updated.length === 0) {
    // 0 rows matched — a concurrent action (e.g. a bulk package release)
    // already completed it. Never audit a write that didn't happen.
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "This consultation is no longer pending." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "consultation.completed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
