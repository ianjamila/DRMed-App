"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { REFERRAL_SOURCE_IDS } from "@/lib/patients/referral-sources";
import { sheetReaderFromEnv } from "@/lib/sheet-sync/config";
import { computeResortGroups } from "@/lib/sheet-sync/resort";
import {
  LeaseLostError,
  revertRunPaged,
  runSheetSync,
  SyncBusyError,
  withAdminLease,
  type RevertSummary,
  type RunOutcome,
} from "@/lib/sheet-sync/run";
import { createSupabaseStore } from "@/lib/sheet-sync/store";

const PATH = "/staff/admin/sheet-sync";

type ErrResult = { ok: false; error: string };
type ActionResult = { ok: true } | ErrResult;
type ActionDataResult<T> = { ok: true; data: T } | ErrResult;

// Mirrors run.ts's OUR_CODE rule: only our own hand-authored codes (P0062–
// P0064, 22023) are safe to pass through translatePgError. Any other code —
// a PostgREST error (PGRST*), a foreign SQLSTATE (22P02, 08006, …) — could
// carry raw column/constraint text, so it goes to the generic message with
// the full error logged server-side instead.
const OUR_CODE = /^(P006[2-4]|22023)$/i;

// runSheetSync (run.ts) throws a plain Error with no .code when the tabs
// already finished but the run's own bookkeeping row failed to write — the
// tab work already committed, so this isn't a normal failure and deserves
// its own message. Detected by message text: run.ts has no dedicated error
// class for it and this task doesn't touch run.ts.
const FINISH_NOT_RECORDED = /could not be recorded as finished/i;

// Shared shape for every action below: requireAdminStaff() -> zod -> store ->
// audit() -> revalidatePath(PATH). Errors go through translatePgError, except
// SyncBusyError / LeaseLostError (our own hand-authored strings — never raw
// DB text) and the review-resolve 22023 for an evidence-based hold, which
// gets its own plain rewording (see resolveReviewItemAction).
function fail(e: unknown): ErrResult {
  if (e instanceof SyncBusyError) {
    return { ok: false, error: "The sheet sync is busy right now — try again in a minute." };
  }
  if (e instanceof LeaseLostError) {
    return { ok: false, error: e.message };
  }
  const err = e as { code?: string; message?: string };
  if (err?.code && OUR_CODE.test(err.code)) {
    return { ok: false, error: translatePgError(err as never) };
  }
  if (e instanceof Error && !err?.code && FINISH_NOT_RECORDED.test(e.message)) {
    console.error("sheet sync action failed (finish not recorded)", e);
    return { ok: false, error: "The change ran but couldn't be recorded as finished — check Run history in a few minutes." };
  }
  console.error("sheet sync action failed", e);
  return { ok: false, error: "Something went wrong. Please try again." };
}

// ---------------------------------------------------------------------------
// 1. Pause / resume
// ---------------------------------------------------------------------------

const PauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(400).nullable(),
});

export async function setSheetSyncPausedAction(
  input: z.infer<typeof PauseSchema>,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = PauseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const admin = createAdminClient();
  const { data: before, error: beforeError } = await admin
    .from("sheet_sync_settings")
    .select("paused")
    .eq("id", true)
    .single();
  if (beforeError) return fail(beforeError);
  if (before?.paused === parsed.data.paused) return { ok: true };

  const now = new Date().toISOString();
  const { error } = await admin
    .from("sheet_sync_settings")
    .update({
      paused: parsed.data.paused,
      paused_at: parsed.data.paused ? now : null,
      paused_by: parsed.data.paused ? session.user_id : null,
      pause_reason: parsed.data.paused ? parsed.data.reason || null : null,
      updated_at: now,
    })
    .eq("id", true);
  if (error) return fail(error);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: parsed.data.paused ? "sheet_sync.paused" : "sheet_sync.resumed",
    resource_type: "sheet_sync_settings",
    resource_id: null,
    metadata: { reason: parsed.data.paused ? parsed.data.reason : null },
    ip_address: ip,
    user_agent: ua,
  });
  revalidatePath(PATH);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 2. Sync now / preview
// ---------------------------------------------------------------------------

export type RunOutcomeSummary = Pick<RunOutcome, "runId" | "status" | "durationMs" | "perTab" | "error">;

export async function runSheetSyncNowAction(input: {
  dryRun: boolean;
}): Promise<ActionDataResult<RunOutcomeSummary>> {
  const session = await requireAdminStaff();
  try {
    const outcome = await runSheetSync({
      store: createSupabaseStore(createAdminClient()),
      readSheet: sheetReaderFromEnv(),
      trigger: "manual",
      actorId: session.user_id,
      dryRun: input.dryRun === true,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      data: {
        runId: outcome.runId,
        status: outcome.status,
        durationMs: outcome.durationMs,
        perTab: outcome.perTab,
        error: outcome.error,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 3. Review queue resolve (link / create / dismiss) — Task 15 builds the UI
//    on this action; it lives here because it shares the six-action file.
// ---------------------------------------------------------------------------

const ResolveSchema = z.object({
  itemId: z.string().uuid(),
  action: z.enum(["link", "create", "dismiss"]),
  patientId: z.string().uuid().nullable(),
});

export async function resolveReviewItemAction(
  input: z.infer<typeof ResolveSchema>,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = ResolveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  if (parsed.data.action === "link" && !parsed.data.patientId) {
    return { ok: false, error: "Pick the patient first." };
  }

  try {
    await createSupabaseStore(createAdminClient()).reviewResolve(
      parsed.data.itemId,
      session.user_id,
      parsed.data.action,
      parsed.data.patientId,
    );
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // 0170: dismissing a row held for an EVIDENCE-based reason (not an undo
    // hold) is refused with 22023 — "Keep undone" (Task 15) is the only
    // dismiss-like action allowed on those, and it goes through this same
    // action. Reword the DB's guard message to what the UI is actually
    // asking the admin to do next.
    if (err?.code === "22023" && parsed.data.action === "dismiss") {
      return { ok: false, error: "This item needs a link or a new patient; it can't be dismissed." };
    }
    return fail(e);
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "sheet_sync.review_resolved",
    resource_type: "sheet_sync_review_item",
    resource_id: parsed.data.itemId,
    patient_id: parsed.data.action === "link" ? parsed.data.patientId : null,
    metadata: { action: parsed.data.action },
    ip_address: ip,
    user_agent: ua,
  });
  revalidatePath(PATH);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Map an unmapped "how did you hear" answer to a channel
// ---------------------------------------------------------------------------

const AliasSchema = z.object({
  itemId: z.string().uuid(),
  sourceId: z.enum(REFERRAL_SOURCE_IDS),
});

export async function mapAnswerToChannelAction(
  input: z.infer<typeof AliasSchema>,
): Promise<ActionDataResult<{ patientsUpdated: number }>> {
  const session = await requireAdminStaff();
  const parsed = AliasSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const admin = createAdminClient();
  const { data: item, error } = await admin
    .from("sheet_sync_review_items")
    .select("item_key, kind, status")
    .eq("id", parsed.data.itemId)
    .single();
  if (error || !item || item.kind !== "unmapped_source" || item.status !== "open") {
    return { ok: false, error: "Someone already handled this review item. Refresh the page." };
  }

  try {
    const store = createSupabaseStore(admin);
    const { runId, result } = await withAdminLease(store, "alias", session.user_id, (lease) =>
      store.aliasApply(lease, item.item_key, parsed.data.sourceId, session.user_id),
    );
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "sheet_sync.alias_set",
      resource_type: "sheet_sync_run",
      resource_id: runId,
      metadata: { review_item_id: parsed.data.itemId, referral_source_id: parsed.data.sourceId, patients_updated: result },
      ip_address: ip,
      user_agent: ua,
    });
    revalidatePath(PATH);
    return { ok: true, data: { patientsUpdated: result } };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 5. Approve a re-sort group
// ---------------------------------------------------------------------------

const ResortSchema = z.object({
  answerNorm: z.string().max(200),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

export async function approveResortGroupAction(
  input: z.infer<typeof ResortSchema>,
): Promise<ActionDataResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = ResortSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const store = createSupabaseStore(createAdminClient());
  try {
    // Recompute on the server — never trust patient ids from the browser.
    const [candidates, aliases] = await Promise.all([store.resortCandidates(), store.loadAliases()]);
    const group = computeResortGroups(candidates, aliases).groups.find(
      (g) => g.answerNorm === parsed.data.answerNorm && g.from === parsed.data.from && g.to === parsed.data.to,
    );
    if (!group) return { ok: false, error: "This group changed since the page loaded. Refresh the page." };

    const { runId, result } = await withAdminLease(store, "resort", session.user_id, (lease) =>
      store.resortApply(lease, group.patientIds, group.from, group.to),
    );
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "sheet_sync.resort_applied",
      resource_type: "sheet_sync_run",
      resource_id: runId,
      metadata: { from: group.from, to: group.to, proposed: group.patientIds.length, updated: result },
      ip_address: ip,
      user_agent: ua,
    });
    revalidatePath(PATH);
    return { ok: true, data: { updated: result } };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 6. Undo a run
// ---------------------------------------------------------------------------

const RevertSchema = z.object({ runId: z.string().uuid() });

export async function revertRunAction(
  input: z.infer<typeof RevertSchema>,
): Promise<ActionDataResult<RevertSummary>> {
  const session = await requireAdminStaff();
  const parsed = RevertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const store = createSupabaseStore(createAdminClient());
  try {
    // Undo is PAGED — never call store.revertRun directly. revertRunPaged
    // pages sheet_sync_revert_run under one admin lease and sums the
    // per-call counts (run.ts). It is refused in SQL (22023) for a run that
    // is itself an undo, a still-running run, or an unknown run id; run
    // history hides Undo for those, so reaching this catch means a race
    // (e.g. someone else undid it between page load and click) — the
    // hand-authored DB message is already plain, so it's shown as-is.
    const { runId, result } = await revertRunPaged(store, session.user_id, parsed.data.runId);
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "sheet_sync.reverted",
      resource_type: "sheet_sync_run",
      resource_id: parsed.data.runId,
      metadata: { undo_run_id: runId, ...result },
      ip_address: ip,
      user_agent: ua,
    });
    revalidatePath(PATH);
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}
