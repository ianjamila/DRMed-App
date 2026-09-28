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
import { isDoctorKind } from "@/lib/visits/order-lines";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import {
  UNCLAIM_REFUSAL_ANY,
  UNCLAIM_REFUSAL_OWN,
  evaluateClaim,
  evaluateUnclaim,
} from "@/lib/queue/claim-eligibility";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { panelKey, type BulkQueueResult, type PanelRef, type SkippedRow } from "@/lib/queue/bulk-queue";
import { loadPanelMembers } from "@/lib/queue/panel-members";
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";

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
  const refusal = ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN;
  if (before.some((r) => !evaluateUnclaim(r, ownerId).ok)) {
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

const PanelRefSchema = z.object({ visitId: z.string().uuid(), groupId: z.string().uuid() });
const BulkClaimSchema = z
  .object({
    testIds: z.array(z.string().uuid()).max(MAX_BULK_SELECTION),
    panels: z.array(PanelRefSchema).max(MAX_BULK_SELECTION),
  })
  .refine(
    (v) => v.testIds.length + v.panels.length >= 1 && v.testIds.length + v.panels.length <= MAX_BULK_SELECTION,
  );

export async function claimTestsAction(input: unknown): Promise<BulkQueueResult> {
  // Role before anything candidate-dependent (spec §9 item 5).
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkClaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const batchId = crypto.randomUUID();
  const ids = Array.from(new Set(parsed.data.testIds));
  const panelsByKey = new Map<string, PanelRef>();
  for (const p of parsed.data.panels) {
    const key = panelKey(p.visitId, p.groupId);
    if (!panelsByKey.has(key)) panelsByKey.set(key, { key, visitId: p.visitId, groupId: p.groupId });
  }
  const panels = [...panelsByKey.values()];

  const supabase = await createClient();

  const loaded = await loadPanelMembers(supabase, panels);
  if (!loaded.ok) {
    return { ok: false, error: "Could not load the chemistry panels — try again." };
  }
  const totalRecords =
    ids.length + [...loaded.members.values()].reduce((n, list) => n + list.length, 0);
  if (totalRecords > MAX_BULK_RECORDS) {
    return { ok: false, error: "Too many tests in one go — select fewer panels." };
  }

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
  const changedPanels: Array<{
    key: string;
    visitId: string;
    groupId: string;
    rows: { id: string; visit_id: string }[];
  }> = [];
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
    // The state the operator saw: requested, nobody holding it.
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
      .eq("id", id)
      .eq("status", "requested")
      .is("assigned_to", null)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Claimed by someone else or changed just now." });
    } else {
      changed.push(data);
    }
  }

  // Whole-panel claim (owner decision): pre-check every live bench member,
  // write with the state the operator SAW, and if the write returns fewer
  // rows than members, hand back what THIS call just took so the panel is
  // never left half-claimed.
  for (const panel of panels) {
    const list = loaded.members.get(panel.key) ?? [];
    if (list.length === 0) {
      skipped.push({ id: panel.key, reason: "Nothing left to claim in this panel — refresh the queue." });
      continue;
    }
    const refusal = list
      .map((m) =>
        evaluateClaim(
          {
            isPackageHeader: m.is_package_header,
            isDoctorLine: isDoctorKind(m.services.kind),
            section: m.services.section,
            visitDeleted: m.visits.deleted_at !== null,
            visit: m.visits,
          },
          session.role,
        ),
      )
      .find((v) => !v.ok);
    if (refusal && !refusal.ok) {
      skipped.push({ id: panel.key, reason: refusal.error });
      continue;
    }
    if (list.some((m) => m.status !== "requested" || m.assigned_to !== null)) {
      skipped.push({ id: panel.key, reason: "Part of this panel is already claimed — open it to check." });
      continue;
    }
    const memberIds = list.map((m) => m.id);
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
      .in("id", memberIds)
      .eq("status", "requested")
      .is("assigned_to", null)
      .is("deleted_at", null)
      .select("id, visit_id");
    if (error) {
      skipped.push({ id: panel.key, reason: translatePgError(error) });
      continue;
    }
    const got = data ?? [];
    if (got.length !== memberIds.length) {
      // Lost a race on part of the panel: hand back what THIS call just took
      // (matched on our own started_at), so a panel is never left half-claimed.
      if (got.length > 0) {
        const compensateIds = got.map((r) => r.id);
        const { data: compensated, error: compensateError } = await supabase
          .from("test_requests")
          .update({ status: "requested", assigned_to: null, started_at: null })
          .in("id", compensateIds)
          .eq("status", "in_progress")
          .eq("assigned_to", session.user_id)
          .eq("started_at", startedAt)
          .select("id");
        if (compensateError) {
          console.error("bulk claim panel compensation failed", {
            panelKey: panel.key,
            ids: compensateIds,
            error: compensateError,
          });
        } else if ((compensated ?? []).length !== compensateIds.length) {
          console.error("bulk claim panel compensation failed", {
            panelKey: panel.key,
            ids: compensateIds,
            error: `expected to restore ${compensateIds.length} rows, restored ${(compensated ?? []).length}`,
          });
        }
      }
      skipped.push({
        id: panel.key,
        reason: "Part of this panel was claimed or changed just now — refresh the queue.",
      });
      continue;
    }
    changedPanels.push({ key: panel.key, visitId: panel.visitId, groupId: panel.groupId, rows: got });
  }

  const { ip, ua } = await ipAndAgent();
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: row.visit_id, bulk_batch_size: ids.length, bulk_batch_id: batchId },
      ip_address: ip,
      user_agent: ua,
    });
  }
  for (const panel of changedPanels) {
    for (const row of panel.rows) {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        action: "test_request.claimed",
        resource_type: "test_request",
        resource_id: row.id,
        metadata: {
          visit_id: row.visit_id,
          bulk_batch_size: totalRecords,
          panel_key: panel.key,
          bulk_batch_id: batchId,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  if (changed.length > 0 || changedPanels.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
    for (const panel of changedPanels) {
      for (const row of panel.rows) revalidatePath(`/staff/queue/${row.id}`);
      revalidatePath(`/staff/queue/consolidated/${panel.visitId}/${panel.groupId}`);
    }
  }
  return {
    ok: true,
    changedIds: [...changed.map((r) => r.id), ...changedPanels.map((p) => p.key)],
    skipped,
    batchId,
  };
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
    .max(MAX_BULK_SELECTION),
  panels: z
    .array(PanelRefSchema.extend({ assignedTo: z.string().uuid() }))
    .max(MAX_BULK_SELECTION)
    .default([]),
  reason: z.string().max(500).optional(),
}).refine(
  (v) => v.items.length + v.panels.length >= 1 && v.items.length + v.panels.length <= MAX_BULK_SELECTION,
);

export async function unclaimTestsAction(input: unknown): Promise<BulkQueueResult> {
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkUnclaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const batchId = crypto.randomUUID();
  // First occurrence of an id wins.
  const seenHolder = new Map<string, string>();
  for (const item of parsed.data.items) {
    if (!seenHolder.has(item.testRequestId)) seenHolder.set(item.testRequestId, item.assignedTo);
  }
  const ids = [...seenHolder.keys()];
  const panelsByKey = new Map<string, PanelRef & { assignedTo: string }>();
  for (const p of parsed.data.panels) {
    const key = panelKey(p.visitId, p.groupId);
    if (!panelsByKey.has(key)) {
      panelsByKey.set(key, { key, visitId: p.visitId, groupId: p.groupId, assignedTo: p.assignedTo });
    }
  }
  const panels = [...panelsByKey.values()];
  const reason = parsed.data.reason?.trim() || null;
  // Same power as the row's Unclaim: admin anyone's, everyone else their own.
  const ownerId = session.role === "admin" ? null : session.user_id;

  const supabase = await createClient();

  const loaded = await loadPanelMembers(supabase, panels);
  if (!loaded.ok) {
    return { ok: false, error: "Could not load the chemistry panels — try again." };
  }
  const totalRecords =
    ids.length + [...loaded.members.values()].reduce((n, list) => n + list.length, 0);
  if (totalRecords > MAX_BULK_RECORDS) {
    return { ok: false, error: "Too many tests in one go — select fewer panels." };
  }

  const { data: before, error: readError } = await supabase
    .from("test_requests")
    .select("id, assigned_to, status, started_at, visits!inner ( id )")
    .in("id", ids)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((before ?? []).map((r) => [r.id, r]));

  const changed: Array<{
    id: string;
    visit_id: string;
    previous: string;
    previousStartedAt: string | null;
  }> = [];
  const changedPanels: Array<{
    key: string;
    visitId: string;
    groupId: string;
    rows: { id: string; visit_id: string; previous: string; previousStartedAt: string | null }[];
  }> = [];
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
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "requested", assigned_to: null, started_at: null })
      .eq("id", id)
      .eq("status", "in_progress")
      .eq("assigned_to", saw)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Changed just now — refresh the queue." });
    } else {
      changed.push({
        id: data.id,
        visit_id: data.visit_id,
        previous: saw,
        previousStartedAt: row.started_at,
      });
    }
  }

  // Whole-panel unclaim (owner decision): pre-check every live bench member
  // against the holder the operator SAW, and if the write returns fewer rows
  // than members, put back what THIS call just released so the panel is
  // never left half-unclaimed.
  for (const panel of panels) {
    const list = loaded.members.get(panel.key) ?? [];
    if (list.length === 0) {
      skipped.push({ id: panel.key, reason: "Nothing left to unclaim in this panel — refresh the queue." });
      continue;
    }
    if (list.some((m) => m.visits.deleted_at !== null)) {
      skipped.push({ id: panel.key, reason: "Deleted from the queue — restore it before unclaiming it." });
      continue;
    }
    const refusal = list.map((m) => evaluateUnclaim(m, ownerId)).find((v) => !v.ok);
    if (refusal && !refusal.ok) {
      skipped.push({ id: panel.key, reason: refusal.error });
      continue;
    }
    if (list.some((m) => m.assigned_to !== panel.assignedTo)) {
      skipped.push({ id: panel.key, reason: "Someone else holds part of this panel now — refresh the queue." });
      continue;
    }
    const startedAtOf = new Map(list.map((m) => [m.id, m.started_at]));
    const memberIds = list.map((m) => m.id);
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "requested", assigned_to: null, started_at: null })
      .in("id", memberIds)
      .eq("status", "in_progress")
      .eq("assigned_to", panel.assignedTo)
      .is("deleted_at", null)
      .select("id, visit_id");
    if (error) {
      skipped.push({ id: panel.key, reason: translatePgError(error) });
      continue;
    }
    const got = data ?? [];
    if (got.length !== memberIds.length) {
      // Lost a race on part of the panel: put back what THIS call just
      // released, so a panel is never left half-unclaimed.
      const compensateIds = got.map((r) => r.id);
      let compensatedCount = 0;
      let compensateError: unknown = null;
      for (const row of got) {
        const { data: restored, error } = await supabase
          .from("test_requests")
          .update({
            status: "in_progress",
            assigned_to: panel.assignedTo,
            started_at: startedAtOf.get(row.id) ?? null,
          })
          .eq("id", row.id)
          .eq("status", "requested")
          .is("assigned_to", null)
          .select("id");
        if (error) {
          compensateError ??= error;
        } else if ((restored ?? []).length > 0) {
          compensatedCount += 1;
        }
      }
      if (compensateError || compensatedCount !== compensateIds.length) {
        console.error("bulk unclaim panel compensation failed", {
          panelKey: panel.key,
          ids: compensateIds,
          error:
            compensateError ??
            `expected to restore ${compensateIds.length} rows, restored ${compensatedCount}`,
        });
      }
      skipped.push({ id: panel.key, reason: "Part of this panel changed just now — refresh the queue." });
      continue;
    }
    changedPanels.push({
      key: panel.key,
      visitId: panel.visitId,
      groupId: panel.groupId,
      rows: got.map((row) => ({
        id: row.id,
        visit_id: row.visit_id,
        previous: panel.assignedTo,
        previousStartedAt: startedAtOf.get(row.id) ?? null,
      })),
    });
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
        previous_started_at: row.previousStartedAt,
        reason,
        self_service: ownerId !== null,
        bulk_batch_size: ids.length,
        bulk_batch_id: batchId,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }
  for (const panel of changedPanels) {
    for (const row of panel.rows) {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        action: "test_request.unclaimed",
        resource_type: "test_request",
        resource_id: row.id,
        metadata: {
          visit_id: row.visit_id,
          previous_assignee: row.previous,
          previous_started_at: row.previousStartedAt,
          reason,
          self_service: ownerId !== null,
          bulk_batch_size: totalRecords,
          panel_key: panel.key,
          bulk_batch_id: batchId,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  if (changed.length > 0 || changedPanels.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
    for (const panel of changedPanels) {
      for (const row of panel.rows) revalidatePath(`/staff/queue/${row.id}`);
      revalidatePath(`/staff/queue/consolidated/${panel.visitId}/${panel.groupId}`);
    }
  }
  return {
    ok: true,
    changedIds: [...changed.map((r) => r.id), ...changedPanels.map((p) => p.key)],
    skipped,
    batchId,
  };
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
