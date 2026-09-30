"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { canClaimSection, claimOwnerLabel, claimOwnerRole } from "@/lib/auth/role-sections";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";
import { RELEASE_MEDIA } from "@/lib/visits/release-media";
import { evaluateRelease, RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import { isConsentGateRequired, getConsentCurrentByPatient } from "@/lib/consent/gate";
import { isActivePatient } from "@/lib/patients/active";
import { releaseVisitSelection } from "@/lib/actions/visits/release-reports";
import { isDoctorKind } from "@/lib/visits/order-lines";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import {
  UNCLAIM_REFUSAL_ANY,
  UNCLAIM_REFUSAL_OWN,
  evaluateClaim,
  evaluateUnclaim,
} from "@/lib/queue/claim-eligibility";
import { ipAndAgent } from "@/lib/server/action-helpers";
import type { BulkQueueResult, BulkReleaseResult, SkippedRow } from "@/lib/queue/bulk-queue";
import { unclaimPanelMembers } from "@/lib/actions/queue/panel-writes";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

export type ClaimResult = { ok: true } | { ok: false; error: string };

const HOLDER_CHANGED = "Someone else holds this now — refresh the queue.";

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
  // Every refusal lives in evaluateClaim (src/lib/queue/claim-eligibility.ts)
  // so the bulk claim refuses a row for exactly the same reason. isDoctorKind
  // stays HERE, beside the read (query-surfaces.test.ts looks for it).
  const verdict = evaluateClaim(
    {
      isPackageHeader: testRequest.is_package_header,
      isDoctorLine: isDoctorKind(testRequest.services.kind),
      section: testRequest.services.section,
      visitDeleted: testRequest.visits.deleted_at !== null,
      visit: testRequest.visits,
    },
    session.role,
  );
  if (!verdict.ok) return verdict;

  // Only claim if currently 'requested' — concurrency-safe. A conditional
  // UPDATE like this is safe to retry once: a real commit rolls back whole
  // on P0072/40P01 (the lifecycle lock, 0184 — e.g. the visit's patient is
  // merged mid-claim), so a retry can never double-claim.
  const { data, error } = await withLifecycleRetry(() =>
    supabase
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
      .maybeSingle(),
  );

  if (error) return { ok: false, error: translatePgError(error) };
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
  // Each test's holder as the operator SAW it (the queue list and panel page
  // send it). When given, a test held by anyone else now is refused — an
  // admin may release anyone's claim, but never one taken over since.
  seenHolders?: ReadonlyMap<string, string>,
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
  if (seenHolders && before.some((r) => r.assigned_to !== seenHolders.get(r.id))) {
    return { ok: false, error: HOLDER_CHANGED };
  }
  // All-or-nothing for a group: refuse up front rather than hand back half a
  // chemistry panel. The UPDATE below re-proves the same predicate.
  const refusal = ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN;
  if (before.some((r) => !evaluateUnclaim(r, ownerId).ok)) {
    return { ok: false, error: refusal };
  }

  // A consolidated panel is handed back in ONE statement (0191,
  // unclaim_panel_members): every member under the one holder the pre-read
  // saw, or nothing — a member that changes in between raises P0077 instead
  // of leaving the report half returned.
  if (testRequestIds.length > 1) {
    // Every member's own holder, as the pre-read saw it — evaluateUnclaim
    // above already proved each is in progress and, for a non-admin, theirs.
    // An admin can so recover a panel split between two people.
    const visitOf = new Map(before.map((r) => [r.id, r.visits.id]));
    const result = await unclaimPanelMembers(session, supabase, {
      members: before.map((r) => ({ id: r.id, holder: r.assigned_to! })),
      visitIdOf: (id) => visitOf.get(id) ?? null,
      reason: reason?.trim() || null,
      selfService: ownerId !== null,
    });
    if (!result.ok) return result;
    revalidatePath("/staff/queue");
    for (const id of testRequestIds) revalidatePath(`/staff/queue/${id}`);
    return { ok: true };
  }

  // Only an in-flight claim with no uploaded result can be unclaimed. A
  // queue-deleted line (0125) is refused even via a stale link — same rule as
  // claim and reassign. Retry once: this conditional UPDATE rolls back whole
  // on a P0072/40P01 lock race (0184), so a retry can't double-unclaim.
  let update = supabase
    .from("test_requests")
    .update({ status: "requested", assigned_to: null, started_at: null })
    .in("id", testRequestIds)
    .eq("status", "in_progress")
    .not("assigned_to", "is", null)
    .is("deleted_at", null);
  if (ownerId !== null) update = update.eq("assigned_to", ownerId);
  const { data, error } = await withLifecycleRetry(() => update.select("id, visit_id"));

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

const QueueUnclaimSchema = z
  .object({
    testRequestIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION),
    // Parallel to testRequestIds: each test's holder as the operator saw it.
    holders: z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.holders.length === v.testRequestIds.length);

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
  const { testRequestIds, holders, reason } = parsed.data;
  return performUnclaim(
    session,
    testRequestIds,
    reason,
    session.role === "admin" ? null : session.user_id,
    new Map(testRequestIds.map((id, i) => [id, holders[i]!])),
  );
}

// ---------------------------------------------------------------------------
// Bulk claim / unclaim from the queue list's selection bar (spec §6).
// Per-row atomicity: each row is evaluated and written on its own, one skip
// never blocks the rest, and every id sent comes back in exactly one of
// changedIds / skipped. Independent single-test rows only — chemistry panels
// get no checkbox, so performUnclaim's all-or-nothing panel contract above is
// untouched.
// ---------------------------------------------------------------------------

const NOT_LAB_STAFF = "Only lab staff can claim or unclaim tests from the queue.";
const BULK_INPUT_ERROR = "Could not read the selection — refresh the queue and try again.";

const BulkClaimSchema = z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION);

export async function claimTestsAction(input: unknown): Promise<BulkQueueResult> {
  // Role before anything candidate-dependent (spec §9 item 5).
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkClaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const ids = Array.from(new Set(parsed.data));

  const supabase = await createClient();
  const { data: rows, error: readError } = await supabase
    .from("test_requests")
    .select(
      "id, is_package_header, services!inner ( kind, section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("id", ids)
    // A queue-deleted line (0125) reads as not found.
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const changed: Array<{ id: string; visit_id: string }> = [];
  const skipped: SkippedRow[] = [];
  const startedAt = new Date().toISOString();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue or no longer exists." });
      continue;
    }
    const verdict = evaluateClaim(
      {
        isPackageHeader: row.is_package_header,
        isDoctorLine: isDoctorKind(row.services.kind),
        section: row.services.section,
        visitDeleted: row.visits.deleted_at !== null,
        visit: row.visits,
      },
      session.role,
    );
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    // The state the operator saw: requested, nobody holding it. Retry once —
    // this conditional UPDATE rolls back whole on a P0072/40P01 lock race
    // (0184), so a retry can't double-claim the row.
    const { data, error } = await withLifecycleRetry(() =>
      supabase
        .from("test_requests")
        .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
        .eq("id", id)
        .eq("status", "requested")
        .is("assigned_to", null)
        .is("deleted_at", null)
        .select("id, visit_id")
        .maybeSingle(),
    );
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Claimed by someone else or changed just now." });
    } else {
      changed.push(data);
    }
  }

  const { ip, ua } = await ipAndAgent();
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: row.visit_id, bulk_batch_size: ids.length },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped };
}

// ---------------------------------------------------------------------------
// Bulk release from the lab queue. A combined (chemistry) report is released
// whole or not at all — the per-visit pipeline (releaseVisitSelection) owns
// the membership reads, the fail-closed rules, the write, the completeness
// check and the notices. This action owns the role gate, the selected-rows
// read and per-row eligibility, and the revalidation.
// ---------------------------------------------------------------------------

const BulkReleaseSchema = z.object({
  testRequestIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_RECORDS),
  medium: z.enum(RELEASE_MEDIA),
});

export async function releaseTestsAction(input: unknown): Promise<BulkReleaseResult> {
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: RELEASE_REFUSAL.reception };
  }
  const parsed = BulkReleaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const ids = Array.from(new Set(parsed.data.testRequestIds));
  const { medium } = parsed.data;

  const supabase = await createClient();
  const { data: rows, error: readError } = await supabase
    .from("test_requests")
    .select(
      "id, status, visit_id, is_package_header, services!inner ( kind, section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id, patient_id, patients!inner ( deleted_at, merged_into_id ) )",
    )
    .in("id", ids)
    // A queue-deleted line (0125) reads as not found.
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const gateRequired = await isConsentGateRequired();
  const consentByPatient = gateRequired
    ? await getConsentCurrentByPatient((rows ?? []).map((r) => r.visits.patient_id))
    : new Map<string, boolean>();

  const skipped = new Map<string, string>();
  const survivorsByVisit = new Map<string, string[]>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.set(id, "Deleted from the queue or no longer exists.");
      continue;
    }
    const patient = row.visits.patients;
    const verdict = evaluateRelease(
      {
        status: row.status,
        isPackageHeader: row.is_package_header,
        isDoctorLine: isDoctorKind(row.services.kind),
        section: row.services.section,
        visitDeleted: row.visits.deleted_at !== null,
        patientActive: isActivePatient(patient ? { drm_id: "", ...patient } : null),
        visit: row.visits,
        consentOnFile: consentByPatient.get(row.visits.patient_id) ?? false,
        gateRequired,
      },
      session.role,
    );
    if (!verdict.ok) {
      skipped.set(id, verdict.error);
      continue;
    }
    survivorsByVisit.set(row.visit_id, [...(survivorsByVisit.get(row.visit_id) ?? []), id]);
  }

  const changedIds: string[] = [];
  const alsoReleasedIds: string[] = [];
  const warnings: string[] = [];
  // A few visits at a time; results are aggregated in order of first
  // appearance in the input, whatever order the visits finish in.
  const outcomes = await mapWithConcurrency([...survivorsByVisit], 4, ([visitId, selectedIds]) =>
    releaseVisitSelection({
      supabase,
      session,
      visitId,
      selectedIds,
      medium,
      auditMeta: { source: "queue" },
    }),
  );
  for (const out of outcomes) {
    changedIds.push(...out.changedIds);
    alsoReleasedIds.push(...out.alsoReleasedIds);
    for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
    for (const s of out.skipped) skipped.set(s.id, s.reason);
  }

  // Every id sent lands in exactly one of changedIds / skipped.
  const changedSet = new Set(changedIds);
  for (const id of ids) {
    if (!changedSet.has(id) && !skipped.has(id)) skipped.set(id, "Released by someone else or changed just now.");
  }

  revalidatePath("/(staff)/staff/(dashboard)/queue", "layout");
  revalidatePath("/staff");
  for (const visitId of survivorsByVisit.keys()) revalidatePath(`/staff/visits/${visitId}`);
  return {
    ok: true,
    changedIds,
    alsoReleasedIds,
    skipped: ids.filter((id) => skipped.has(id) && !changedSet.has(id)).map((id) => ({ id, reason: skipped.get(id)! })),
    warnings,
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const BulkUnclaimSchema = z.object({
  items: z
    .array(
      z.object({
        testRequestId: z.string().uuid(),
        // The holder the operator SAW — the write only lands while it still holds.
        assignedTo: z.string().uuid(),
      }),
    )
    .min(1)
    .max(MAX_BULK_SELECTION),
  reason: z.string().max(500).optional(),
});

export async function unclaimTestsAction(input: unknown): Promise<BulkQueueResult> {
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkUnclaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  // First occurrence of an id wins.
  const seenHolder = new Map<string, string>();
  for (const item of parsed.data.items) {
    if (!seenHolder.has(item.testRequestId)) seenHolder.set(item.testRequestId, item.assignedTo);
  }
  const ids = [...seenHolder.keys()];
  const reason = parsed.data.reason?.trim() || null;
  // Same power as the row's Unclaim: admin anyone's, everyone else their own.
  const ownerId = session.role === "admin" ? null : session.user_id;

  const supabase = await createClient();
  const { data: before, error: readError } = await supabase
    .from("test_requests")
    .select("id, assigned_to, status, visits!inner ( id )")
    .in("id", ids)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((before ?? []).map((r) => [r.id, r]));

  const changed: Array<{ id: string; visit_id: string; previous: string }> = [];
  const skipped: SkippedRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const saw = seenHolder.get(id)!;
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue — restore it before unclaiming it." });
      continue;
    }
    const verdict = evaluateUnclaim(row, ownerId);
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    if (row.assigned_to !== saw) {
      skipped.push({ id, reason: "Someone else holds this test now — refresh the queue." });
      continue;
    }
    // Retry once — this conditional UPDATE rolls back whole on a
    // P0072/40P01 lock race (0184), so a retry can't double-unclaim the row.
    const { data, error } = await withLifecycleRetry(() =>
      supabase
        .from("test_requests")
        .update({ status: "requested", assigned_to: null, started_at: null })
        .eq("id", id)
        .eq("status", "in_progress")
        .eq("assigned_to", saw)
        .is("deleted_at", null)
        .select("id, visit_id")
        .maybeSingle(),
    );
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Changed just now — refresh the queue." });
    } else {
      changed.push({ id: data.id, visit_id: data.visit_id, previous: saw });
    }
  }

  // Same audit shape as performUnclaim, so the queue's Remarks column
  // (queue_claim_remarks, 0160) reads bulk unclaims unchanged.
  const { ip, ua } = await ipAndAgent();
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.unclaimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: row.visit_id,
        previous_assignee: row.previous,
        reason,
        self_service: ownerId !== null,
        bulk_batch_size: ids.length,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped };
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

  // Retry once — this conditional UPDATE rolls back whole on a P0072/40P01
  // lock race (0184), so a retry can't double-reassign the row.
  const { data, error } = await withLifecycleRetry(() =>
    supabase
      .from("test_requests")
      .update({ assigned_to: newAssigneeId })
      .eq("id", testRequestId)
      .in("status", ["in_progress", "result_uploaded"])
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle(),
  );

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
