"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { canClaimSection, sectionsForRole } from "@/lib/auth/role-sections";
import { MAX_BULK_SELECTION, scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { partitionConsolidatedMembers } from "@/lib/results/consolidated-reports";
import { panelRowKey, type BulkQueueResult, type SkippedRow } from "@/lib/queue/bulk-queue";
import {
  finaliseConsolidatedReport,
  type FinaliseResult,
} from "@/lib/actions/results/finalise-consolidated";
import {
  amendConsolidatedReport,
  type AmendConsolidatedResult,
} from "@/lib/actions/results/amend-consolidated";

const ClaimSchema = z.object({
  testRequestIds: z.array(z.string().uuid()).min(1),
});

type ClaimOutcome = { ok: true } | { ok: false; error: string };
type Supabase = Awaited<ReturnType<typeof createClient>>;

// Every check + the all-or-nothing write for one panel's bench members. Shared
// by this page's Claim (ids the page rendered) and the queue list's Claim /
// bulk Claim (ids resolved server-side by panelBenchIds), so the two claim
// paths refuse a panel for exactly the same reasons.
async function claimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  testRequestIds: string[],
  auditExtra: Record<string, unknown> = {},
): Promise<ClaimOutcome> {
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

  // Only claim if every member is still 'requested' — concurrency-safe,
  // matching claimTestAction's semantics for single tests.
  const { data, error } = await supabase
    .from("test_requests")
    .update({
      assigned_to: session.user_id,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
    .in("id", testRequestIds)
    .eq("status", "requested")
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if ((data ?? []).length !== testRequestIds.length) {
    // A member changed between the check above and this write, so the
    // status filter claimed only part of the panel. Hand those rows straight
    // back — the report is claimed whole or not at all.
    const partial = (data ?? []).map((r) => r.id);
    if (partial.length > 0) {
      await supabase
        .from("test_requests")
        .update({ assigned_to: null, status: "requested", started_at: null })
        .in("id", partial)
        .eq("status", "in_progress")
        .eq("assigned_to", session.user_id);
    }
    return {
      ok: false,
      error: "Some tests in this report were already claimed or changed status.",
    };
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

export async function claimConsolidated(input: unknown): Promise<ClaimOutcome> {
  try {
    const { testRequestIds } = ClaimSchema.parse(input);
    const session = await requireActiveStaff();
    const supabase = await createClient();
    const result = await claimPanelMembers(session, supabase, testRequestIds);
    if (result.ok) revalidatePath("/staff/queue");
    return result;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Claim from the queue LIST (the panel row's Claim and the bulk bar).
//
// The list pages by test row BEFORE folding chemistry into one card, so a card
// can show only part of its panel. These actions therefore never trust ids
// from the list: they take (visit, report group) and resolve the panel's
// bench members here — the same rows, and the same partition, the panel page
// passes to claimConsolidated. A panel is claimed whole or not at all.
// ---------------------------------------------------------------------------

const PanelSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
});
const PanelsSchema = z.array(PanelSchema).min(1).max(MAX_BULK_SELECTION);

async function panelBenchIds(
  supabase: Supabase,
  visitId: string,
  groupId: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  // Mirrors the panel page's member read: scoped by report group, package
  // headers out, cancelled out, soft-deleted lines and visits out.
  const { data, error } = await supabase
    .from("test_requests")
    .select(
      "id, status, services!inner ( report_group_id ), visits!inner ( deleted_at ), result_test_requests ( result_id, results ( storage_path ) )",
    )
    .eq("visit_id", visitId)
    .eq("services.report_group_id", groupId)
    .eq("is_package_header", false)
    .neq("status", "cancelled")
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (error) return { ok: false, error: translatePgError(error) };
  const one = <T,>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  const { encodeIds } = partitionConsolidatedMembers(
    (data ?? []).map((r) => {
      const link = one(r.result_test_requests);
      return {
        id: r.id,
        status: r.status,
        resultId: link?.result_id ?? null,
        hasPdf: Boolean(one(link?.results ?? null)?.storage_path),
      };
    }),
  );
  if (encodeIds.length === 0) {
    return { ok: false, error: "Nothing in this report is waiting to be claimed." };
  }
  return { ok: true, ids: encodeIds };
}

/** The chemistry row's own Claim button on the queue list. */
export async function claimPanelAction(input: unknown): Promise<ClaimOutcome> {
  const parsed = PanelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Could not read this report — refresh the queue and try again." };
  }
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const members = await panelBenchIds(supabase, parsed.data.visitId, parsed.data.groupId);
  if (!members.ok) return members;
  const result = await claimPanelMembers(session, supabase, members.ids, {
    visit_id: parsed.data.visitId,
    report_group_id: parsed.data.groupId,
  });
  if (result.ok) revalidatePath("/staff/queue");
  return result;
}

/**
 * The bulk bar's Claim for selected chemistry rows. Each panel is its own
 * all-or-nothing claim; one refusal never blocks the others. `changedIds` are
 * the TEST ids claimed (so the bar can count tests); a refused panel comes
 * back in `skipped` under its row key (panelRowKey), which is how the bar
 * names it.
 */
export async function claimPanelsAction(input: unknown): Promise<BulkQueueResult> {
  const parsed = PanelsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Could not read the selection — refresh the queue and try again." };
  }
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const seen = new Set<string>();
  const changedIds: string[] = [];
  const skipped: SkippedRow[] = [];
  for (const { visitId, groupId } of parsed.data) {
    const key = panelRowKey(visitId, groupId);
    if (seen.has(key)) continue;
    seen.add(key);
    const members = await panelBenchIds(supabase, visitId, groupId);
    if (!members.ok) {
      skipped.push({ id: key, reason: members.error });
      continue;
    }
    const result = await claimPanelMembers(session, supabase, members.ids, {
      visit_id: visitId,
      report_group_id: groupId,
      bulk_batch_size: parsed.data.length,
    });
    if (result.ok) changedIds.push(...members.ids);
    else skipped.push({ id: key, reason: result.error });
  }
  if (changedIds.length > 0) revalidatePath("/staff/queue");
  return { ok: true, changedIds, skipped };
}

const FinaliseSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
  testRequestIds: z.array(z.string().uuid()).min(1),
  values: z.array(
    z.object({
      parameter_id: z.string().uuid(),
      numeric_value_si: z.number().nullable(),
      numeric_value_conv: z.number().nullable(),
    }),
  ),
});

export async function finaliseConsolidated(
  input: unknown,
): Promise<FinaliseResult> {
  try {
    const parsed = FinaliseSchema.parse(input);
    return await finaliseConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const AmendSchema = z.object({
  resultId: z.string().uuid(),
  expectedAmendmentCount: z.number().int().min(0),
  reason: z.string(),
  values: z.array(
    z.object({
      parameter_id: z.string().uuid(),
      numeric_value_si: z.number().nullable(),
      numeric_value_conv: z.number().nullable(),
    }),
  ),
  notifyPatient: z.boolean().optional(),
});

export async function amendConsolidated(input: unknown): Promise<AmendConsolidatedResult> {
  try {
    const parsed = AmendSchema.parse(input);
    return await amendConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
