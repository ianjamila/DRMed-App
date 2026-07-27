"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";

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
    .select("id, is_package_header, visits!inner ( deleted_at )")
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

export async function unclaimTestAction(
  testRequestId: string,
  reason?: string,
): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  const supabase = await createClient();

  // Pre-read the current holder for the audit row — the post-update select
  // would return assigned_to already nulled.
  const { data: before } = await supabase
    .from("test_requests")
    .select("assigned_to")
    .eq("id", testRequestId)
    .maybeSingle();

  // Only an in-flight claim with no uploaded result can be unclaimed.
  const { data, error } = await supabase
    .from("test_requests")
    .update({ status: "requested", assigned_to: null, started_at: null })
    .eq("id", testRequestId)
    .eq("status", "in_progress")
    .not("assigned_to", "is", null)
    .select("id, visit_id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) {
    return {
      ok: false,
      error: "Only claimed, in-progress tests can be unclaimed.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.unclaimed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: data.visit_id,
      previous_assignee: before?.assigned_to ?? null,
      reason: reason?.trim() || null,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true };
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

  // Fetch the current assignee first so the audit row records the handover.
  const { data: before } = await supabase
    .from("test_requests")
    .select("assigned_to")
    .eq("id", testRequestId)
    .maybeSingle();

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
