"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import {
  canClaimSection,
  claimOwnerLabel,
  claimOwnerRole,
  sectionsForRole,
} from "@/lib/auth/role-sections";
import {
  MAX_BULK_SELECTION,
  scopeToAllowedSections,
} from "@/lib/visits/bulk-selection";
import { isDoctorKind } from "@/lib/visits/order-lines";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";

export type ClaimResult = { ok: true } | { ok: false; error: string };

export async function claimTestAction(
  testRequestId: string,
): Promise<ClaimResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // Defense in depth: headers carry no work, so reject any attempt to claim
  // one even if someone reaches this path via URL trick or stale state. The
  // queue list already filters is_package_header=false.
  const { data: testRequest } = await supabase
    .from("test_requests")
    .select(
      "id, is_package_header, services!inner ( kind, section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!testRequest) {
    return { ok: false, error: "Test not found." };
  }
  // Whole-visit deletes don't cascade deleted_at onto lines — check the
  // parent here so a stale tab can't claim work on a deleted visit.
  if (testRequest.visits.deleted_at !== null) {
    return { ok: false, error: "This visit was deleted from the queue." };
  }
  if (testRequest.is_package_header) {
    return {
      ok: false,
      error: "Package headers cannot be claimed — they have no work.",
    };
  }
  // Same reasoning for doctor lines: a consultation has no bench step to
  // claim. The section gate below cannot refuse one — doctor services carry a
  // null `section`, which passes for the unrestricted roles by design (that
  // is what lets an admin mark a consultation done). So admin/pathologist
  // could claim a consultation into `in_progress`, where it would then sit
  // forever: nothing on the bench can move it on.
  if (isDoctorKind(testRequest.services.kind)) {
    return {
      ok: false,
      error:
        "Consultations and procedures are completed on the visit page with “Mark done”, not claimed from the lab queue.",
    };
  }
  // Section gate, server-side: RLS lets every lab role (and reception) write
  // test_requests, so the queue list's section filter is UX, not the guard.
  // reception's [] denies outright; a null-section doctor line survives only
  // for admin/pathologist — the same rule as the release actions.
  if (
    scopeToAllowedSections([testRequest], sectionsForRole(session.role)).length ===
    0
  ) {
    return {
      ok: false,
      error: "This test is outside the sections you can claim.",
    };
  }
  // Single-owner sections (x-ray → x-ray technician): the role scope above
  // lets admin/pathologist through, so this is the check that keeps them out.
  const owner = claimOwnerRole(testRequest.services.section);
  if (owner && !canClaimSection(session.role, testRequest.services.section)) {
    return {
      ok: false,
      error: `Only an ${claimOwnerLabel(owner)} can claim this test.`,
    };
  }
  // Payment gate (item 10, decision 1): the queue hides these rows, but a
  // stale tab or direct link must not start lab work on an unpaid visit.
  const gate = labQueueGate(testRequest.visits);
  if (!gate.ok) {
    return { ok: false, error: gate.hint };
  }

  // Only claim if currently 'requested' — concurrency-safe.
  const { data, error } = await supabase
    .from("test_requests")
    .update({
      status: "in_progress",
      assigned_to: session.user_id,
      started_at: new Date().toISOString(),
    })
    .eq("id", testRequestId)
    .eq("status", "requested")
    // A queue-deleted line (0125) is not claimable even via a stale link.
    .is("deleted_at", null)
    .select("id, visit_id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) {
    return {
      ok: false,
      error: "This test was already claimed or its status changed.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.claimed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: data.visit_id },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true };
}

// Roles that can hold a lab claim — reassignment targets must be one of these.
const LAB_CAPABLE_ROLES = [
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
] as const;

// Shared by the admin unclaim (any holder) and the self-service unclaim (own
// claim only). `ownerId` narrows the UPDATE to rows the caller holds — RLS on
// test_requests is role-scoped, not row-scoped (0023), so ownership has to be
// proven here, in the WHERE clause, the same way claimTestAction proves
// `status = 'requested'`.
//
// Takes a LIST so the queue page can hand back a consolidated chemistry card
// (one claim spread over several tests, taken together by claimConsolidated)
// in one go. A single test is a list of one.
async function performUnclaim(
  session: StaffSession,
  testRequestIds: string[],
  reason: string | undefined,
  ownerId: string | null,
): Promise<ClaimResult> {
  if (testRequestIds.length === 0) {
    return { ok: false, error: "Nothing to unclaim." };
  }
  const supabase = await createClient();

  // Pre-read the current holders for the audit rows — the post-update select
  // would return assigned_to already nulled.
  const { data: before } = await supabase
    .from("test_requests")
    .select("id, assigned_to, status, visits!inner ( id )")
    .in("id", testRequestIds)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  // An UPDATE can't filter an embedded table, so the write below carries only
  // the line's own deleted_at — this read is what covers a live line on a
  // DELETED visit (0125 does not cascade visit → lines). Same rule as
  // claimTestAction.
  if (!before || before.length !== testRequestIds.length) {
    return {
      ok: false,
      error:
        "This entry was deleted from the queue. Restore it before unclaiming it.",
    };
  }
  // All-or-nothing for a group: refuse up front rather than hand back half a
  // chemistry panel. The UPDATE below re-proves the same predicate.
  const refusal =
    ownerId === null
      ? "Only claimed, in-progress tests can be unclaimed."
      : "You can only unclaim a test you currently hold that has no result yet.";
  if (
    before.some(
      (r) =>
        r.status !== "in_progress" ||
        r.assigned_to === null ||
        (ownerId !== null && r.assigned_to !== ownerId),
    )
  ) {
    return { ok: false, error: refusal };
  }

  // Only an in-flight claim with no uploaded result can be unclaimed. A
  // queue-deleted line (0125) is refused even via a stale link — same rule as
  // claim and reassign.
  let update = supabase
    .from("test_requests")
    .update({ status: "requested", assigned_to: null, started_at: null })
    .in("id", testRequestIds)
    .eq("status", "in_progress")
    .not("assigned_to", "is", null)
    .is("deleted_at", null);
  if (ownerId !== null) update = update.eq("assigned_to", ownerId);
  const { data, error } = await update.select("id, visit_id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data || data.length === 0) return { ok: false, error: refusal };

  // One row per test, keyed by resource_id, so each line's claim history (the
  // queue's Remarks column, queue_claim_remarks) reads it directly.
  const holderById = new Map(before.map((r) => [r.id, r.assigned_to]));
  const h = await headers();
  for (const row of data) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.unclaimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: row.visit_id,
        previous_assignee: holderById.get(row.id) ?? null,
        reason: reason?.trim() || null,
        self_service: ownerId !== null,
        ...(testRequestIds.length > 1 ? { grouped: true } : {}),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  revalidatePath("/staff/queue");
  for (const id of testRequestIds) revalidatePath(`/staff/queue/${id}`);
  if (data.length !== testRequestIds.length) {
    // Lost a race on part of a group between the pre-read and the write.
    return {
      ok: false,
      error:
        "Some tests in this report changed status while unclaiming — refresh and check the queue.",
    };
  }
  return { ok: true };
}

// Admin: hand ANY stuck claim back to the queue (the ReassignPanel's Unclaim).
export async function unclaimTestAction(
  testRequestId: string,
  reason?: string,
): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  return performUnclaim(session, [testRequestId], reason, null);
}

// Self-service: a lab worker hands their OWN claim back (wrong section, end of
// shift, sample problem). Ownership is the whole gate — claimTestAction already
// section-scopes who can hold a claim, so anyone holding one may release it.
// Audited like the admin path, flagged `self_service` so the two stay
// distinguishable in the log.
export async function unclaimOwnTestAction(
  testRequestId: string,
  reason?: string,
): Promise<ClaimResult> {
  const session = await requireActiveStaff();
  return performUnclaim(session, [testRequestId], reason, session.user_id);
}

const QueueUnclaimSchema = z.object({
  testRequestIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION),
  reason: z.string().max(500).optional(),
});

// The queue LIST's Unclaim: one entry point for a single test or a
// consolidated chemistry card. An admin may hand back anyone's claim (same
// power as the ReassignPanel); everyone else only their own.
export async function unclaimFromQueueAction(
  input: unknown,
): Promise<ClaimResult> {
  const parsed = QueueUnclaimSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Could not unclaim — refresh the queue and try again." };
  }
  const session = await requireActiveStaff();
  const { testRequestIds, reason } = parsed.data;
  return performUnclaim(
    session,
    testRequestIds,
    reason,
    session.role === "admin" ? null : session.user_id,
  );
}

export async function reassignTestAction(
  testRequestId: string,
  newAssigneeId: string,
): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  const supabase = await createClient();

  // The new assignee must be an active staff member in a lab-capable role.
  const { data: assignee } = await supabase
    .from("staff_profiles")
    .select("id, role, is_active, deleted_at")
    .eq("id", newAssigneeId)
    .maybeSingle();
  if (
    !assignee ||
    !assignee.is_active ||
    assignee.deleted_at !== null ||
    !(LAB_CAPABLE_ROLES as readonly string[]).includes(assignee.role)
  ) {
    return {
      ok: false,
      error:
        "The selected staff member can't take lab work — pick an active medtech, X-ray technician, pathologist, or admin.",
    };
  }

  // Fetch the current assignee first so the audit row records the handover —
  // and the section, so the new holder can be checked against it below.
  const { data: before } = await supabase
    .from("test_requests")
    .select("assigned_to, services!inner ( section ), visits!inner ( id )")
    .eq("id", testRequestId)
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    // Lab work only — a consultation is never claimed (claimTestAction), so
    // it has no holder to hand over.
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
    .maybeSingle();
  // An UPDATE can't filter an embedded table, so the write below carries only
  // the line's own deleted_at — this read is what covers a live line on a
  // DELETED visit (0125 does not cascade visit → lines). Same rule as
  // claimTestAction.
  if (!before) {
    return {
      ok: false,
      error:
        "This entry was deleted from the queue. Restore it before reassigning it.",
    };
  }
  // Reassigning hands the new holder a claim, so it obeys the same rule as
  // claiming: a medtech cannot be handed an x-ray, and neither can an admin.
  if (
    !canClaimSection(
      assignee.role as StaffSession["role"],
      before.services.section,
    )
  ) {
    const owner = claimOwnerRole(before.services.section);
    return {
      ok: false,
      error: owner
        ? `Only an ${claimOwnerLabel(owner)} can hold this test — pick one of them.`
        : "The selected staff member does not work this test's section.",
    };
  }

  const { data, error } = await supabase
    .from("test_requests")
    .update({ assigned_to: newAssigneeId })
    .eq("id", testRequestId)
    .in("status", ["in_progress", "result_uploaded"])
    .is("deleted_at", null)
    .select("id, visit_id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) {
    return {
      ok: false,
      error:
        "Only in-progress or result-uploaded tests can be reassigned — this test's status changed.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.reassigned",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: data.visit_id,
      from: before?.assigned_to ?? null,
      to: newAssigneeId,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true };
}
