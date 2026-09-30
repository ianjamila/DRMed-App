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
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { canClaimSection, sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";

export type PanelOutcome = { ok: true } | { ok: false; error: string };
type Supabase = Awaited<ReturnType<typeof createClient>>;

// Every check + the all-or-nothing claim for one panel's bench members.
export async function claimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  testRequestIds: string[],
  auditExtra: Record<string, unknown> = {},
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
  // panel all-or-nothing under concurrency.
  const { error } = await supabase.rpc("claim_panel_members", {
    p_test_request_ids: testRequestIds,
  });
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.claimed",
    resource_type: "test_request",
    resource_id: null,
    metadata: { test_request_ids: testRequestIds, grouped: true, ...auditExtra },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });
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
  },
): Promise<PanelOutcome> {
  const { error } = await supabase.rpc("unclaim_panel_members", {
    p_test_request_ids: args.members.map((m) => m.id),
    p_holders: args.members.map((m) => m.holder),
  });
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
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true };
}
