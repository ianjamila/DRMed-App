"use server";

// The queue LIST's actions on consolidated chemistry panels: the panel row's
// Claim, and the bulk bar's Claim / Unclaim / Delete over a selection that
// mixes single tests and panels.
//
// The list pages by test row BEFORE folding chemistry into one card, so a card
// can show part of its panel (and the Unclaimed tab hides a member someone
// already holds). These actions never trust ids from the list: they take
// (visit, report group), read the panel's FULL membership with the same
// helper the page renders from (fetchPanelMembers + summarizePanel), and act
// on all of it. Each panel is all-or-nothing (claim_panel_members /
// unclaim_panel_members, 0191; the delete guard triggers, per visit); one
// refused panel never blocks the rest of the selection.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { MAX_BULK_RECORDS, MAX_BULK_ROWS } from "@/lib/ui/bulk-selection";
import { QUEUE_DELETE_ROLES } from "@/lib/visits/deletion";
import { UNCLAIM_REFUSAL_ANY, UNCLAIM_REFUSAL_OWN } from "@/lib/queue/claim-eligibility";
import {
  combineClaimResults,
  panelRowKey,
  type BulkQueueResult,
  type SkippedRow,
} from "@/lib/queue/bulk-queue";
import { fetchPanelMembers, summarizePanel, type PanelRef, type PanelState } from "@/lib/queue/panel-members";
import {
  claimPanelMembers,
  unclaimPanelMembers,
  type PanelOutcome,
} from "@/lib/actions/queue/panel-writes";
import { deleteTestRequestsManyAction } from "@/lib/actions/visits/queue-deletion";
import { claimTestsAction, unclaimTestsAction } from "./actions";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const INPUT_ERROR = "Could not read the selection — refresh the queue and try again.";
const NOTHING_ON_BENCH = "Nothing in this report is waiting on the bench any more — refresh the queue.";

const PanelSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
});
const HeldPanelSchema = PanelSchema.extend({
  // The holder the operator SAW — the hand-back only lands while it still holds.
  assignedTo: z.string().uuid(),
});

const rowsWithin = (n: number) => n > 0 && n <= MAX_BULK_ROWS;

async function resolvePanels(
  supabase: Supabase,
  session: StaffSession,
  refs: readonly PanelRef[],
): Promise<{ ok: true; states: Map<string, PanelState> } | { ok: false; error: string }> {
  const read = await fetchPanelMembers(supabase, refs);
  if (!read.ok) return { ok: false, error: "Could not read the report — refresh the queue and try again." };
  const states = new Map<string, PanelState>();
  for (const [key, members] of read.byKey) {
    // Deletability is re-proven by the delete guard triggers; the server
    // never needs the shared-report lookup the page uses for its button.
    states.set(
      key,
      summarizePanel(members, { role: session.role, userId: session.user_id, sharedReportIds: new Set() }),
    );
  }
  return { ok: true, states };
}

/** Distinct panels in selection order, each with its row key. */
function uniquePanels<T extends PanelRef>(panels: readonly T[]): Array<T & { key: string }> {
  const seen = new Set<string>();
  const out: Array<T & { key: string }> = [];
  for (const p of panels) {
    const key = panelRowKey(p.visitId, p.groupId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, key });
  }
  return out;
}

function tooMany(total: number): BulkQueueResult {
  return {
    ok: false,
    error: `Too many tests selected — ${total} with every chemistry panel counted in full; the limit is ${MAX_BULK_RECORDS} per action.`,
  };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/** The chemistry row's own Claim button. */
export async function claimPanelAction(input: unknown): Promise<PanelOutcome> {
  const parsed = PanelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Could not read this report — refresh the queue and try again." };
  }
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const resolved = await resolvePanels(supabase, session, [parsed.data]);
  if (!resolved.ok) return resolved;
  const state = resolved.states.get(panelRowKey(parsed.data.visitId, parsed.data.groupId));
  if (!state || state.benchIds.length === 0) return { ok: false, error: NOTHING_ON_BENCH };
  const result = await claimPanelMembers(session, supabase, state.benchIds, {
    visit_id: parsed.data.visitId,
    report_group_id: parsed.data.groupId,
  });
  if (result.ok) revalidatePath("/staff/queue");
  return result;
}

const ClaimSelectionSchema = z
  .object({
    testRequestIds: z.array(z.string().uuid()).max(MAX_BULK_ROWS),
    panels: z.array(PanelSchema).max(MAX_BULK_ROWS),
  })
  .refine((v) => rowsWithin(v.testRequestIds.length + v.panels.length));

/**
 * The bulk bar's Claim: single tests and panels in ONE call, so the record
 * budget is checked against the whole expanded selection before anything is
 * claimed. `changedIds` are TEST ids; a refused panel comes back in `skipped`
 * under its row key, which is how the bar names it.
 */
export async function claimQueueSelectionAction(input: unknown): Promise<BulkQueueResult> {
  const parsed = ClaimSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INPUT_ERROR };
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const singleIds = Array.from(new Set(parsed.data.testRequestIds));
  const panels = uniquePanels(parsed.data.panels);

  const resolved = await resolvePanels(supabase, session, panels);
  if (!resolved.ok) return resolved;
  const total =
    singleIds.length +
    panels.reduce((n, p) => n + (resolved.states.get(p.key)?.benchIds.length ?? 0), 0);
  if (total > MAX_BULK_RECORDS) return tooMany(total);

  // The single-test path keeps its own role/input refusals; a refused call is
  // refused for the panels too (nothing has been claimed yet).
  const single = singleIds.length > 0 ? await claimTestsAction(singleIds) : null;
  if (single && !single.ok) return single;

  const changedIds: string[] = [];
  const skipped: SkippedRow[] = [];
  for (const panel of panels) {
    const state = resolved.states.get(panel.key);
    if (!state || state.benchIds.length === 0) {
      skipped.push({ id: panel.key, reason: NOTHING_ON_BENCH });
      continue;
    }
    const result = await claimPanelMembers(session, supabase, state.benchIds, {
      visit_id: panel.visitId,
      report_group_id: panel.groupId,
      bulk_batch_size: singleIds.length + panels.length,
    });
    if (result.ok) changedIds.push(...state.benchIds);
    else skipped.push({ id: panel.key, reason: result.error });
  }
  if (changedIds.length > 0) revalidatePath("/staff/queue");
  return combineClaimResults(single, { ok: true, changedIds, skipped }, []);
}

// ---------------------------------------------------------------------------
// Unclaim
// ---------------------------------------------------------------------------

const UnclaimSelectionSchema = z
  .object({
    items: z
      .array(z.object({ testRequestId: z.string().uuid(), assignedTo: z.string().uuid() }))
      .max(MAX_BULK_ROWS),
    panels: z.array(HeldPanelSchema).max(MAX_BULK_ROWS),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => rowsWithin(v.items.length + v.panels.length));

/**
 * The bulk bar's Unclaim. Single tests go through unclaimTestsAction
 * unchanged; each panel is handed back whole (unclaim_panel_members) while
 * every bench member is still in progress under the holder the operator saw.
 */
export async function unclaimQueueSelectionAction(input: unknown): Promise<BulkQueueResult> {
  const parsed = UnclaimSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INPUT_ERROR };
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const reason = parsed.data.reason?.trim() || undefined;
  const panels = uniquePanels(parsed.data.panels);

  const resolved = await resolvePanels(supabase, session, panels);
  if (!resolved.ok) return resolved;
  const total =
    parsed.data.items.length +
    panels.reduce((n, p) => n + (resolved.states.get(p.key)?.benchIds.length ?? 0), 0);
  if (total > MAX_BULK_RECORDS) return tooMany(total);

  const single =
    parsed.data.items.length > 0
      ? await unclaimTestsAction({ items: parsed.data.items, reason })
      : null;
  if (single && !single.ok) return single;

  const refusal = session.role === "admin" ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN;
  const changedIds: string[] = [];
  const skipped: SkippedRow[] = [];
  for (const panel of panels) {
    const state = resolved.states.get(panel.key);
    if (!state || state.benchIds.length === 0) {
      skipped.push({ id: panel.key, reason: NOTHING_ON_BENCH });
      continue;
    }
    if (state.holder !== null && state.holder !== panel.assignedTo) {
      skipped.push({ id: panel.key, reason: "Someone else holds this report now — refresh the queue." });
      continue;
    }
    if (!state.unclaimable) {
      skipped.push({ id: panel.key, reason: refusal });
      continue;
    }
    const result = await unclaimPanelMembers(session, supabase, {
      testRequestIds: state.benchIds,
      holder: panel.assignedTo,
      visitIdOf: () => panel.visitId,
      reason: reason ?? null,
      selfService: session.role !== "admin",
      auditExtra: { bulk_batch_size: parsed.data.items.length + panels.length },
    });
    if (result.ok) changedIds.push(...state.benchIds);
    else skipped.push({ id: panel.key, reason: result.error });
  }
  if (changedIds.length > 0) {
    revalidatePath("/staff/queue");
    for (const id of changedIds) revalidatePath(`/staff/queue/${id}`);
  }
  return combineClaimResults(single, { ok: true, changedIds, skipped }, []);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const DeleteSelectionSchema = z
  .object({
    testRequestIds: z.array(z.string().uuid()).max(MAX_BULK_ROWS),
    panels: z.array(PanelSchema).max(MAX_BULK_ROWS),
    reason: z.string(),
  })
  .refine((v) => rowsWithin(v.testRequestIds.length + v.panels.length));

/**
 * The bulk bar's Delete. A panel is deleted WHOLE — every live member, not
 * just the ones its page showed — in its own call, so it is one visit's
 * atomic statement (the 0125/0147/0172 guards refuse all of it or none).
 * Deletion itself, its reason rules and its audit rows are
 * deleteTestRequestsManyAction's, unchanged.
 */
export async function deleteQueueSelectionAction(input: unknown): Promise<BulkQueueResult> {
  const parsed = DeleteSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INPUT_ERROR };
  // Role before any candidate-dependent read (spec §9 item 5), same as the
  // single-test bulk delete.
  const session = await requireActiveStaff();
  if (!QUEUE_DELETE_ROLES.has(session.role)) {
    return { ok: false, error: "Only reception or admin can delete queue entries." };
  }
  const supabase = await createClient();
  const singleIds = Array.from(new Set(parsed.data.testRequestIds));
  const panels = uniquePanels(parsed.data.panels);

  const resolved = await resolvePanels(supabase, session, panels);
  if (!resolved.ok) return resolved;
  const total =
    singleIds.length +
    panels.reduce((n, p) => n + (resolved.states.get(p.key)?.allIds.length ?? 0), 0);
  if (total > MAX_BULK_RECORDS) return tooMany(total);

  const changedIds: string[] = [];
  const skipped: SkippedRow[] = [];
  if (singleIds.length > 0) {
    const single = await deleteTestRequestsManyAction({
      testRequestIds: singleIds,
      reason: parsed.data.reason,
    });
    // Role / reason / input refusal: nothing was deleted, refuse it all.
    if (!single.ok) return single;
    changedIds.push(...single.changedIds);
    skipped.push(...single.skipped);
  }
  for (const panel of panels) {
    const state = resolved.states.get(panel.key);
    if (!state || state.allIds.length === 0) {
      skipped.push({ id: panel.key, reason: "Already deleted or no longer exists." });
      continue;
    }
    const result = await deleteTestRequestsManyAction({
      testRequestIds: state.allIds,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      // Nothing has been deleted yet → the refusal (a bad reason) is the
      // whole answer; otherwise report it against this panel.
      if (changedIds.length === 0 && skipped.length === 0) return result;
      skipped.push({ id: panel.key, reason: result.error });
      continue;
    }
    changedIds.push(...result.changedIds);
    // One visit, one statement: a refusal covers every member. Name the
    // panel once, with the first reason.
    if (result.skipped.length > 0) {
      skipped.push({ id: panel.key, reason: result.skipped[0]!.reason });
    }
  }
  return { ok: true, changedIds, skipped };
}
