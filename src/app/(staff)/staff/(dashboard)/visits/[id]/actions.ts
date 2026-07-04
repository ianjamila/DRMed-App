"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { notifyResultsReleasedBulk } from "@/lib/notifications/notify-released-bulk";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reportError } from "@/lib/observability/report-error";

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

  const now = new Date().toISOString();
  // Single user-scoped UPDATE: per-row payment/consent triggers still enforce
  // the gates; the header then auto-releases via the Leg A trigger.
  const { data: released, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
    })
    .eq("parent_id", headerId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .select("id, services ( name )");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!released || released.length === 0) {
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
