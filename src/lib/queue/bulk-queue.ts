// Pure pieces of the lab queue's bulk bar (spec §6): the selection kinds a
// row carries, the server actions' result shape, and the message the bar
// shows afterwards. Lives in src/lib because "use server" modules may only
// export async functions and both sides need these.

export const QUEUE_KIND = {
  claim: "claimable",
  unclaim: "unclaimable",
  delete: "deletable",
} as const;
export type QueueKind = (typeof QUEUE_KIND)[keyof typeof QUEUE_KIND];

/** Kinds for one single-test row, from the same predicates that decide which buttons the row shows. */
export function queueRowKinds(flags: {
  claimable: boolean;
  unclaimable: boolean;
  deletable: boolean;
}): QueueKind[] {
  const kinds: QueueKind[] = [];
  if (flags.claimable) kinds.push(QUEUE_KIND.claim);
  if (flags.unclaimable) kinds.push(QUEUE_KIND.unclaim);
  if (flags.deletable) kinds.push(QUEUE_KIND.delete);
  return kinds;
}

export interface SkippedRow {
  id: string;
  reason: string;
}

/** Every id sent lands in exactly one of changedIds / skipped. */
export type BulkQueueResult =
  | { ok: true; changedIds: string[]; skipped: SkippedRow[] }
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
  return { ok: true, changedIds, skipped };
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
  const changed = result.changedIds.length;
  const head =
    changed === 0
      ? `Nothing ${verb.toLowerCase()}.`
      : changed === sentCount
        ? `${verb} ${changed} ${tests(changed)}.`
        : `${verb} ${changed} of ${sentCount} ${tests(sentCount)}.`;
  if (result.skipped.length === 0) return head;
  const lines = result.skipped.map(
    (s) => `• ${rowsByKey[s.id]?.label ?? "A test"}: ${s.reason}`,
  );
  return [head, `Not changed (${result.skipped.length}):`, ...lines].join("\n");
}
