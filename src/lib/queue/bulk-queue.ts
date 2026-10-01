// Pure pieces of the lab queue's bulk bar (spec §6): the selection kinds a
// row carries, the server actions' result shape, and the message the bar
// shows afterwards. Lives in src/lib because "use server" modules may only
// export async functions and both sides need these.

import { formatBulkOutcome } from "@/lib/ui/bulk-outcome";
import { visitDeletability } from "@/lib/visits/deletion";

export const QUEUE_KIND = {
  claim: "claimable",
  unclaim: "unclaimable",
  release: "releasable",
  delete: "deletable",
  /** Admin-only: the row belongs to a sample visit (Delete sample visit…). */
  sampleDelete: "sample_deletable",
} as const;
export type QueueKind = (typeof QUEUE_KIND)[keyof typeof QUEUE_KIND];

/**
 * Who sees "Delete sample visit…" and its checkbox: an ADMIN (the effective
 * role — View as folded in), on a row of a sample visit. The server re-proves
 * both (deleteSampleVisitFromQueueAction); this only decides what to render.
 */
export function canDeleteSampleVisit(role: string, isSample: boolean): boolean {
  return role === "admin" && isSample;
}

/**
 * The hint to show in place of "Delete sample visit…" when the visit's PAYMENT
 * state already blocks any delete (recorded payments, a waived balance) — the
 * visit page's DeleteBlockedHint pattern; null when nothing blocks.
 *
 * Only the payment rules are asked: the lines and HMO-claim inputs are passed
 * as "nothing there" on purpose (the Queue card does not carry them), so open
 * HMO claims and line-level blockers stay SERVER-side refusals, reported per
 * visit by the action.
 */
export function samplePaymentBlock(role: string, paymentStatus: string): string | null {
  const d = visitDeletability(role, {
    payment_status: paymentStatus,
    deleted_at: null,
    test_statuses: [],
    has_open_hmo_claim: false,
  });
  return !d.ok && (d.reason === "has_payments" || d.reason === "waived") ? d.hint : null;
}

/**
 * Does the Queue list render row checkboxes (and its bulk bar)? Worklist tabs
 * for everyone but reception. "Released today" is a record, not a worklist,
 * so only an admin gets checkboxes there — and the page then puts a
 * checkbox on sample-visit rows only (canDeleteSampleVisit), whose only kind
 * is QUEUE_KIND.sampleDelete.
 */
export function queueSelectable(opts: { role: string; receptionView: boolean; releasedTab: boolean }): boolean {
  if (opts.receptionView) return false;
  return !opts.releasedTab || opts.role === "admin";
}

/** Kinds for one single-test row, from the same predicates that decide which buttons the row shows. */
export function queueRowKinds(flags: {
  claimable: boolean;
  unclaimable: boolean;
  releasable: boolean;
  deletable: boolean;
  sampleDeletable?: boolean;
}): QueueKind[] {
  const kinds: QueueKind[] = [];
  if (flags.claimable) kinds.push(QUEUE_KIND.claim);
  if (flags.unclaimable) kinds.push(QUEUE_KIND.unclaim);
  if (flags.releasable) kinds.push(QUEUE_KIND.release);
  if (flags.deletable) kinds.push(QUEUE_KIND.delete);
  if (flags.sampleDeletable) kinds.push(QUEUE_KIND.sampleDelete);
  return kinds;
}

/**
 * deleteTestRequestsManyCore's refusal when EVERY id it was given is already
 * deleted or gone (before any write). Shared, not duplicated: the bulk Delete
 * action recognises it to tell a stale set of single tests apart from a role /
 * reason / input refusal, which must still refuse the whole selection.
 */
export const NOTHING_TO_DELETE_REFUSAL =
  "Nothing to delete — these tests were already deleted or no longer exist.";
/** The per-row reason for a test or panel that was already deleted or is gone. */
export const ALREADY_DELETED_REASON = "Already deleted or no longer exists.";

export interface SkippedRow {
  id: string;
  reason: string;
}

/**
 * Every id sent lands in exactly one of changedIds / skipped. Ids are
 * SELECTION keys — a test id, or a panel key for a whole panel.
 */
export type BulkQueueResult =
  | { ok: true; changedIds: string[]; skipped: SkippedRow[]; batchId?: string }
  | { ok: false; error: string };

/** What the bar knows about a selectable row — serialisable, built by the server page. */
export interface QueueRowInfo {
  visitId: string;
  /** "CBC — Santos, Maria": how the result message names the row. */
  label: string;
  /** The holder the operator SAW (unclaim sends it as a predicate); null when unclaimed. */
  assignedTo: string | null;
  /** Tests Delete acts on — every live member of a chemistry panel row. 1 when absent. */
  testCount?: number;
  /** Tests Claim / Unclaim act on — a panel's members still on the bench. testCount when absent. */
  benchCount?: number;
  /** A panel row's bench members and holders as rendered — what its Unclaim sends as "what I saw". */
  bench?: Array<{ id: string; holder: string | null }>;
  /** A chemistry panel card: the test ids it stands for (its rowKey is the card key). */
  memberIds?: string[];
  /** "Visit #1234 — Santos, Maria": how the sample-visit delete names the visit. */
  visitLabel?: string;
}

/** Result of deleteSampleVisitsFromQueueAction. Skipped ids are VISIT ids. */
export type BulkSampleDeleteResult =
  | { ok: true; deletedVisitIds: string[]; skipped: SkippedRow[]; unreleasedCount: number }
  | { ok: false; error: string };

/**
 * The distinct visits "Delete N sample visits…" would act on, or [] when the
 * action must NOT be offered: nothing selected, or ANY selected row is not a
 * sample-visit row the bar knows (a mixed selection is never silently
 * trimmed to its sample rows). `sampleKeys` are the selected keys carrying
 * the sample kind; `selectedCount` is every selected key.
 */
export function sampleDeleteVisitIds(
  selectedCount: number,
  sampleKeys: readonly string[],
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string[] {
  if (selectedCount === 0 || sampleKeys.length !== selectedCount) return [];
  const ids: string[] = [];
  for (const key of sampleKeys) {
    const row = rowsByKey[key];
    if (!row) return [];
    ids.push(row.visitId);
  }
  return [...new Set(ids)];
}

/** The outcome text of a sample-visit bulk delete: deleted count, then every skipped visit with its reason. */
export function sampleDeleteMessage(
  visitIds: readonly string[],
  result: { deletedVisitIds: readonly string[]; skipped: readonly SkippedRow[]; unreleasedCount: number },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string {
  const labelOfVisit = new Map<string, string>();
  for (const row of Object.values(rowsByKey)) {
    if (!labelOfVisit.has(row.visitId)) labelOfVisit.set(row.visitId, row.visitLabel ?? row.label);
  }
  const base = formatBulkOutcome({
    verb: "Deleted",
    noun: { one: "sample visit", many: "sample visits" },
    sent: visitIds.length,
    changed: result.deletedVisitIds.length,
    notChanged: result.skipped.map((s) => ({
      label: labelOfVisit.get(s.id) ?? "A visit",
      reason: s.reason,
    })),
  });
  const n = result.unreleasedCount;
  return n === 0 ? base : `${base}\nUn-released ${n} result${n === 1 ? "" : "s"} first.`;
}

// A chemistry panel row is selected as ONE row but claimed server-side by
// (visit, report group): the list pages before the fold, so the ids on screen
// can be part of the panel. Its selection key carries both ids.
const PANEL_KEY_PREFIX = "panel:";

export function panelRowKey(visitId: string, groupId: string): string {
  return `${PANEL_KEY_PREFIX}${visitId}:${groupId}`;
}

export function parsePanelRowKey(key: string): { visitId: string; groupId: string } | null {
  if (!key.startsWith(PANEL_KEY_PREFIX)) return null;
  const [visitId, groupId, ...rest] = key.slice(PANEL_KEY_PREFIX.length).split(":");
  if (!visitId || !groupId || rest.length > 0) return null;
  return { visitId, groupId };
}

/**
 * One result for a bulk action that ran the single tests and the chemistry
 * panels separately (queue/panel-actions.ts). A refusal of the whole
 * single-test call is returned as-is — the caller never runs the panels then.
 * A refusal of a whole panel call lands every key in `panelKeys` in
 * `skipped`, because the single tests before it DID change.
 * The batch id (one per call, shared by the single tests and the panels — the
 * caller minted it once) rides the result only when something changed: it is
 * what shows the bar's Undo, and there is nothing to undo otherwise.
 */
export function combineClaimResults(
  single: BulkQueueResult | null,
  panels: BulkQueueResult | null,
  panelKeys: readonly string[],
): BulkQueueResult {
  if (single && !single.ok) return single;
  const changedIds = [...(single?.changedIds ?? [])];
  const skipped = [...(single?.skipped ?? [])];
  if (panels) {
    if (panels.ok) {
      changedIds.push(...panels.changedIds);
      skipped.push(...panels.skipped);
    } else {
      skipped.push(...panelKeys.map((id) => ({ id, reason: panels.error })));
    }
  }
  const batchId = single?.batchId ?? (panels?.ok ? panels.batchId : undefined);
  return {
    ok: true,
    changedIds,
    skipped,
    ...(batchId && changedIds.length > 0 ? { batchId } : {}),
  };
}

/**
 * How many TESTS a bulk action was sent: every changed test once, plus each
 * skipped row weighted by the tests that action would have changed — its
 * bench members for Claim / Unclaim, every member for Delete. Equal to the
 * key count when every row is a single test.
 */
export function sentTestCount(
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[] },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
  scope: "bench" | "all" = "all",
): number {
  return (
    result.changedIds.length +
    result.skipped.reduce((n, s) => n + rowTestCount(rowsByKey[s.id], scope), 0)
  );
}

/** Tests one selected row stands for, for the action's scope. */
export function rowTestCount(row: QueueRowInfo | undefined, scope: "bench" | "all"): number {
  if (!row) return 1;
  return scope === "bench" ? (row.benchCount ?? row.testCount ?? 1) : (row.testCount ?? 1);
}

/** Result of releaseTestsAction: BulkQueueResult plus the report-mates a release pulled in. */
export type BulkReleaseResult =
  | {
      ok: true;
      changedIds: string[];
      skipped: SkippedRow[];
      alsoReleasedIds: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

function tests(n: number): string {
  return `test${n === 1 ? "" : "s"}`;
}

/**
 * "Claimed 3 of 5 tests." plus one line per skipped row, naming it and why.
 * Every skipped row is named (at most 100, the action cap): the bar clears
 * the selection afterwards, so this message is the only record of what was
 * left alone. `verb` is past tense, capitalised.
 */
export function bulkQueueMessage(
  verb: string,
  sentCount: number,
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[] },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string {
  return formatBulkOutcome({
    verb,
    noun: { one: "test", many: "tests" },
    sent: sentCount,
    changed: result.changedIds.length,
    notChanged: result.skipped.map((s) => ({
      label: rowsByKey[s.id]?.label ?? "A test",
      reason: s.reason,
    })),
  });
}

/** Expand panel rows so an outcome message can name a skipped member test by its card. */
export function labelsByTestId(
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): Record<string, QueueRowInfo> {
  const out: Record<string, QueueRowInfo> = {};
  for (const [key, info] of Object.entries(rowsByKey)) {
    if (info.memberIds) for (const id of info.memberIds) out[id] = info;
    else out[key] = info;
  }
  return out;
}

/** bulkQueueMessage("Released", …) plus a line for report members released along with the selection. */
export function bulkReleaseMessage(
  sentCount: number,
  result: {
    changedIds: readonly string[];
    skipped: readonly SkippedRow[];
    alsoReleasedIds: readonly string[];
  },
  rowsByTestId: Readonly<Record<string, QueueRowInfo>>,
): string {
  const base = bulkQueueMessage("Released", sentCount, result, rowsByTestId);
  const n = result.alsoReleasedIds.length;
  return n === 0 ? base : `${base}\nAlso released ${n} other ${tests(n)} on the same combined report.`;
}
