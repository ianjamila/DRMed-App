// The all-or-nothing writes for a consolidated chemistry panel — claim and
// hand back — shared by every entry point: the panel page's Claim, the queue
// row's Claim / Unclaim, and the queue's bulk bar. Plain module (not "use
// server"): these trust the session their caller already resolved, so they
// must never be exported as endpoints.
//
// The writes themselves are claim_panel_members / unclaim_panel_members
// (0191): one statement each, all members or none (P0077). The TypeScript
// checks in front only turn the common refusals into a clean message.

import { headers } from "next/headers";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { createClient } from "@/lib/supabase/server";
import type { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { canClaimSection, sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { readInChunks } from "@/lib/supabase/in-chunks";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

export type PanelOutcome = { ok: true } | { ok: false; error: string };
type Supabase = Awaited<ReturnType<typeof createClient>>;
// The service-role client (restore_panel_members is service_role only).
type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The bulk-batch identity of ONE panel write, minted server-side by the bulk
 * action (never read from a browser input — this module is not an endpoint).
 * With it, the write leaves one audit row PER MEMBER carrying the batch id, the
 * panel key and the exact state the bulk Undo needs to reverse it (see
 * planQueueUndo in src/lib/ui/bulk-undo.ts); without it, the shapes the panel
 * page and the row buttons rely on are unchanged.
 */
export interface PanelBatchAudit {
  batchId: string;
  /** Rows in the whole selection (singles + panels), for audit only. */
  batchSize: number;
  panelKey: string;
  visitId: string;
}

// Every check + the all-or-nothing claim for one panel's bench members.
export async function claimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  testRequestIds: string[],
  auditExtra: Record<string, unknown> = {},
  batch?: PanelBatchAudit,
): Promise<PanelOutcome> {
  // Same defense-in-depth pre-read as claimTestAction: a stale tab must not
  // start lab work on a deleted entry, a deleted visit, or a visit still
  // waiting for payment (item 10, decision 1).
  const { data: members } = await supabase
    .from("test_requests")
    .select(
      "id, status, deleted_at, services!inner ( section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("id", testRequestIds);
  if (!members || members.length !== testRequestIds.length) {
    return { ok: false, error: "Some tests in this report were not found." };
  }
  // Refuse BEFORE the write when any member is already taken: the UPDATE
  // below filters on status, so without this it would claim the rest of the
  // panel and only then report the failure — splitting one report between
  // two holders.
  if (members.some((m) => m.status !== "requested")) {
    return {
      ok: false,
      error: "Some tests in this report were already claimed or changed status.",
    };
  }
  if (members.some((m) => m.visits.deleted_at !== null)) {
    return { ok: false, error: "This visit was deleted from the queue." };
  }
  if (members.some((m) => m.deleted_at !== null)) {
    return {
      ok: false,
      error: "Some tests in this report were deleted from the queue.",
    };
  }
  for (const m of members) {
    const gate = labQueueGate(m.visits);
    if (!gate.ok) return { ok: false, error: gate.hint };
  }
  // Section gate, server-side — same rule as claimTestAction: RLS is
  // role-only, so the caller must be allowed every section in the report.
  if (
    scopeToAllowedSections(members, sectionsForRole(session.role)).length !==
    members.length
  ) {
    return {
      ok: false,
      error: "This report is outside the sections you can claim.",
    };
  }
  // Single-owner sections (x-ray → x-ray technician) — the same rule as
  // claimTestAction, so the two claim paths cannot drift.
  if (members.some((m) => !canClaimSection(session.role, m.services.section))) {
    return {
      ok: false,
      error: "Part of this report can only be claimed by another role.",
    };
  }

  // The write itself is claim_panel_members (0191): one statement that
  // claims every member into the caller's name or, when any member is no
  // longer requested/unassigned/live, raises P0077 and claims nothing. The
  // checks above only give a clean message first; this is what makes the
  // panel all-or-nothing under concurrency. P0077 is never retried — that's
  // a real state conflict, not a lock race — but the lifecycle lock this RPC
  // also takes can raise P0072/40P01 (e.g. the visit's patient is merged
  // mid-claim); one retry in a fresh transaction is safe since a real commit
  // rolls back whole.
  const { error } = await withLifecycleRetry(() =>
    supabase.rpc("claim_panel_members", {
      p_test_request_ids: testRequestIds,
    }),
  );
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  if (!batch) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: null,
      metadata: { test_request_ids: testRequestIds, grouped: true, ...auditExtra },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: true };
  }

  // A bulk claim leaves one row PER MEMBER, keyed by resource_id — the shape
  // claimTestsCore writes and planQueueUndo reads — carrying the exact
  // started_at this claim stamped, so Undo can predicate its unclaim on it.
  // The RPC has committed by now, so a failed read-back must not lose the
  // audit: every member is still written, with started_at null and
  // outcome_unverified, which Undo refuses as "changed" (safe).
  const { data: stamped, error: readBackError } = await supabase
    .from("test_requests")
    .select("id, started_at, visits!inner ( id )")
    .in("id", testRequestIds)
    .eq("assigned_to", session.user_id)
    .eq("status", "in_progress")
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  const startedAtById = new Map<string, string | null>();
  if (!readBackError) for (const r of stamped ?? []) startedAtById.set(r.id, r.started_at);
  for (const id of testRequestIds) {
    const startedAt = startedAtById.get(id) ?? null;
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: id,
      metadata: {
        ...auditExtra,
        visit_id: batch.visitId,
        started_at: startedAt,
        panel_key: batch.panelKey,
        bulk_batch_id: batch.batchId,
        bulk_batch_size: batch.batchSize,
        grouped: true,
        ...(startedAt === null ? { outcome_unverified: true } : {}),
      },
      ip_address: ip,
      user_agent: ua,
    });
  }
  return { ok: true };
}

/**
 * Hand a panel's bench members back to the queue in one statement. Each
 * member carries the holder the operator SAW; unclaim_panel_members refuses
 * (P0077) unless every member is still in progress under exactly that holder,
 * and a non-admin may only hand back their own. Per-member holders let an
 * admin recover a panel split between two people. One audit row per test, keyed by resource_id, so the queue's
 * Remarks column (queue_claim_remarks, 0160) reads it like any unclaim.
 */
export async function unclaimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  args: {
    members: ReadonlyArray<{ id: string; holder: string }>;
    visitIdOf: (testRequestId: string) => string | null;
    reason: string | null;
    selfService: boolean;
    auditExtra?: Record<string, unknown>;
    /** Bulk batch identity; adds the batch id, panel key and previous_started_at to each row. */
    batch?: PanelBatchAudit;
    /** The started_at each member held when the operator handed it back (pre-read by the caller). */
    startedAtOf?: (testRequestId: string) => string | null;
  },
): Promise<PanelOutcome> {
  // Same retry-once rule as claimPanelMembers above: P0077 (a member no
  // longer matches its expected holder) is a real conflict and is never
  // retried, but a P0072/40P01 lock race is safe to replay once.
  const { error } = await withLifecycleRetry(() =>
    supabase.rpc("unclaim_panel_members", {
      p_test_request_ids: args.members.map((m) => m.id),
      p_holders: args.members.map((m) => m.holder),
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  for (const { id, holder } of args.members) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.unclaimed",
      resource_type: "test_request",
      resource_id: id,
      metadata: {
        visit_id: args.visitIdOf(id),
        previous_assignee: holder,
        reason: args.reason,
        self_service: args.selfService,
        grouped: true,
        ...(args.auditExtra ?? {}),
        ...(args.batch
          ? {
              panel_key: args.batch.panelKey,
              bulk_batch_id: args.batch.batchId,
              bulk_batch_size: args.batch.batchSize,
              previous_started_at: args.startedAtOf?.(id) ?? null,
            }
          : {}),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true };
}

/**
 * The started_at each bench member holds right now — read ONCE for a whole
 * bulk Unclaim, before any panel is handed back, so every panel's audit rows
 * can carry the exact previous_started_at Undo needs to put the claim back.
 * `ok: false` on a failed read: the caller fails closed per panel rather than
 * hand a report back with no way to reverse it exactly.
 */
export async function readBenchStartedAt(
  supabase: Supabase,
  testRequestIds: readonly string[],
): Promise<{ ok: true; startedAtById: Map<string, string | null> } | { ok: false }> {
  const startedAtById = new Map<string, string | null>();
  if (testRequestIds.length === 0) return { ok: true, startedAtById };
  // Up to MAX_BULK_RECORDS (500) members across the selected panels: read in
  // IN_CHUNK slices, and any failed slice fails the whole read (closed).
  const read = await readInChunks(testRequestIds, (chunk) =>
    supabase
      .from("test_requests")
      .select("id, started_at, visits!inner ( id )")
      .in("id", chunk)
      .is("deleted_at", null)
      .is("visits.deleted_at", null),
  );
  if (!read.ok) return { ok: false };
  for (const r of read.rows) startedAtById.set(r.id, r.started_at);
  return { ok: true, startedAtById };
}

/**
 * Undo of a bulk panel hand-back (0200): every member back under ITS OWN
 * previous holder, at its previous started_at, in one statement — or, when
 * any member was claimed, deleted or changed since, nothing (P0082). The
 * caller has already proven each holder can still hold the test and the
 * visit passes the payment gate; 0190's holder guard is the backstop.
 * Audited like the per-row reclaim it replaces: one test_request.reassigned
 * row per member (from null → holder).
 *
 * `startedAt` is passed to the database exactly as it was read (a string
 * straight from the DB or audit metadata) — never via `new Date(...)`, which
 * would truncate microseconds.
 */
export async function reclaimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  args: {
    members: ReadonlyArray<{ id: string; holder: string; startedAt: string | null }>;
    visitIdOf: (testRequestId: string) => string | null;
    auditExtra?: Record<string, unknown>;
  },
): Promise<PanelOutcome> {
  const { error } = await withLifecycleRetry(() =>
    supabase.rpc("reclaim_panel_members", {
      p_test_request_ids: args.members.map((m) => m.id),
      p_holders: args.members.map((m) => m.holder),
      p_started_at: args.members.map((m) => m.startedAt),
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  for (const m of args.members) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.reassigned",
      resource_type: "test_request",
      resource_id: m.id,
      metadata: { visit_id: args.visitIdOf(m.id), from: null, to: m.holder, grouped: true, ...(args.auditExtra ?? {}) },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true };
}

/**
 * Undo of a bulk panel queue-delete (0200): every top-level member of one
 * visit's panel restored in one statement while each is still deleted at
 * exactly the deleted_at the bulk delete stamped — or nothing (P0082).
 * `admin` must be the service-role client (restore_panel_members is granted
 * to service_role only, like the queue restore it mirrors); the caller has
 * checked the role and that the visit's patient is active. Audited exactly
 * like restoreTestRequestsForVisit: one test_request.restored row per member.
 *
 * `deletedAt` must be the exact string the delete stamped (DB read or audit
 * metadata) — the function matches it to the microsecond, so never round-trip
 * it through `new Date(...)`.
 */
export async function restorePanelMembers(
  session: StaffSession,
  admin: AdminClient,
  args: {
    visitId: string;
    members: ReadonlyArray<{ id: string; deletedAt: string }>;
    reason: string;
    auditExtra?: Record<string, unknown>;
  },
): Promise<{ ok: true; restoredIds: string[] } | { ok: false; error: string }> {
  const ids = args.members.map((m) => m.id);
  // Read BEFORE the restore: what each member's audit row reports (service,
  // prior reason, patient) is its deleted state, which the restore clears.
  // The members ARE deleted (hence no deleted_at filter), but their visit must
  // be live: restore_panel_members refuses a deleted visit, so nothing to audit.
  const { data: before, error: readError } = await admin
    .from("test_requests")
    .select("id, deleted_at, delete_reason, visits!inner ( patient_id ), services ( name, code )")
    .in("id", ids)
    .eq("visit_id", args.visitId)
    .is("visits.deleted_at", null);
  // The read only enriches the audit rows; a failed read must not block the
  // restore (which commits all-or-nothing on its own) — log it and carry on
  // with null enrichment.
  if (readError) {
    console.error("restorePanelMembers pre-read failed", { visitId: args.visitId, error: readError });
  }
  const infoOf = new Map((before ?? []).map((r) => [r.id, r]));

  const { error } = await withLifecycleRetry(() =>
    admin.rpc("restore_panel_members", {
      p_visit_id: args.visitId,
      p_test_request_ids: ids,
      p_deleted_at: args.members.map((m) => m.deletedAt),
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  for (const m of args.members) {
    const info = infoOf.get(m.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: info?.visits.patient_id ?? null,
      action: "test_request.restored",
      resource_type: "test_request",
      resource_id: m.id,
      metadata: {
        visit_id: args.visitId,
        reason: args.reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        prior_delete_reason: info?.delete_reason ?? null,
        prior_deleted_at: info?.deleted_at ?? m.deletedAt,
        bulk: args.members.length > 1,
        ...(args.auditExtra ?? {}),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true, restoredIds: ids };
}
