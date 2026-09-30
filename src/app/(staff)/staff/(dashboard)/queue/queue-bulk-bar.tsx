"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  parsePanelRowKey,
  rowTestCount,
  sentTestCount,
  type BulkQueueResult,
  type QueueRowInfo,
} from "@/lib/queue/bulk-queue";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import { undoBulkQueueAction } from "./actions";
import {
  claimQueueSelectionAction,
  deleteQueueSelectionAction,
  unclaimQueueSelectionAction,
} from "./panel-actions";

interface Props {
  // Every selectable row the page rendered: single tests keyed by test id,
  // chemistry panels by panelRowKey(visit, report group). A panel is acted on
  // WHOLE — the server resolves its full membership (panel-actions.ts).
  rowsByKey: Record<string, QueueRowInfo>;
}

type Panel = null | "unclaim" | "delete";

// Selected keys → single test ids and chemistry panels (panelRowKey).
function splitKeys(keys: readonly string[]) {
  const singleIds: string[] = [];
  const panels: Array<{ key: string; visitId: string; groupId: string }> = [];
  for (const key of keys) {
    const panel = parsePanelRowKey(key);
    if (panel) panels.push({ key, ...panel });
    else singleIds.push(key);
  }
  return { singleIds, panels };
}

interface OutcomeUndo {
  batchId: string;
  doneAt: number;
  /** Every selection key (test id or panel key) this action sent, mapped to
   * that row's label — snapshotted here since the keys may not resolve to a
   * row any more once the page refreshes. */
  labelOf: Record<string, string>;
}

interface Outcome {
  message: string;
  /** The `selectionEdits` value when this outcome was set — see the
   * render-time drop rule below. */
  edits: number;
  undo: OutcomeUndo | null;
}

// The lab queue's selection bar: Claim · Unclaim (optional reason) · Delete
// (required reason, red confirm — QueueDeleteDialog's wording). Each button
// acts on the selected rows that carry its kind; the server re-proves every
// row and reports the ones it skipped by name.
export function QueueBulkBar({ rowsByKey }: Props) {
  const { keysByKind, clearKeys, count, selectionEdits } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  // Separate from the bar's own action transition so an Undo in flight
  // doesn't get mistaken for (or block) a fresh bulk action.
  const [undoing, startUndo] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Which button started the transition in flight — one useTransition serves
  // all three, so without this every visible button would read "…ing".
  const [running, setRunning] = useState<"claim" | "unclaim" | "delete" | null>(null);
  // The last action's outcome, naming every skipped test. An action only
  // clears the keys it acted on, so other selected rows (e.g. an
  // unclaimable test under Claim) can leave `count > 0` — the outcome must
  // still show. It survives until the operator makes a new deliberate edit
  // (toggle/setMany bumps `selectionEdits`), not merely until count is next
  // > 0.
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const known = (keys: string[] | undefined) =>
    (keys ?? []).filter((key) => rowsByKey[key] !== undefined);
  const claimKeys = known(keysByKind[QUEUE_KIND.claim]);
  // A single test sends the holder the operator saw, so it needs one. A
  // panel sends each bench member's holder as seen (it may be split between
  // holders — an admin recovering it), and the server compares them all.
  const unclaimKeys = known(keysByKind[QUEUE_KIND.unclaim]).filter(
    (key) => parsePanelRowKey(key) !== null || rowsByKey[key]!.assignedTo !== null,
  );
  const deleteKeys = known(keysByKind[QUEUE_KIND.delete]);

  function closePanel() {
    setPanel(null);
    setReason("");
    setErr(null);
  }

  function done(verb: string, keys: string[], result: BulkQueueResult, inPanel: boolean, doneAt: number) {
    if (!result.ok) {
      // Nothing was attempted (role / input / reason) — keep the selection.
      if (inPanel) setErr(result.error);
      else alert(result.error);
      return;
    }
    // Claim, Unclaim and Delete all get Undo, for ANY selection — single
    // tests, chemistry panels or a mix (one batch id covers the whole call) —
    // but only when the server gave us that batch id and at least one row
    // actually changed. A panel is undone whole or not at all (see
    // undoBulkQueueAction in actions.ts).
    const undo: OutcomeUndo | null =
      result.batchId && result.changedIds.length > 0
        ? {
            batchId: result.batchId,
            doneAt,
            labelOf: Object.fromEntries(keys.map((key) => [key, rowsByKey[key]?.label ?? "A test"])),
          }
        : null;
    // Counted in TESTS: a panel row stands for several (sentTestCount) — its
    // bench members for Claim / Unclaim, all of them for Delete.
    const scope = verb === "Deleted" ? "all" : "bench";
    setOutcome({
      message: bulkQueueMessage(verb, sentTestCount(result, rowsByKey, scope), result, rowsByKey),
      edits: selectionEdits,
      undo,
    });
    // Pruning wins (spec §4): clear everything sent; the outcome panel is the record.
    clearKeys(keys);
    closePanel();
    router.refresh();
  }

  function runUndo(u: OutcomeUndo) {
    if (undoing) return;
    const previousMessage = outcome?.message ?? "";
    startUndo(async () => {
      const r = await undoBulkQueueAction({ batchId: u.batchId });
      if (!r.ok) {
        // Keep the snapshot so the operator can retry inside the window —
        // unless the server says the window/batch itself is gone, in which
        // case retrying can only repeat the same refusal.
        const gone = r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY;
        setOutcome({
          message: `${r.error}\n\n${previousMessage}`,
          edits: selectionEdits,
          undo: gone ? null : u,
        });
        return;
      }
      // The count is the server's own: the number of TEST rows put back. Not
      // r.restoredIds.length — those are selection keys, one per restored
      // group, so a 10-test panel would read as 1 and the message would
      // disagree with the forward "Claimed 12 tests." The notRestored ids are
      // unique selection keys (test id or panel key) too, so no label-based
      // collapsing is needed (two unnamed walk-ins, or two same-name patients,
      // must still count as two). The label is only for display; the first
      // reason seen per row wins.
      const restoredCount = r.restoredTestCount;
      const notRestoredByKey = new Map<string, { label: string; reason: string }>();
      for (const n of r.notRestored) {
        if (!notRestoredByKey.has(n.id)) {
          notRestoredByKey.set(n.id, { label: u.labelOf[n.id] ?? "A test", reason: n.reason });
        }
      }
      setOutcome({
        message: undoOutcomeMessage(
          { one: "test", many: "tests" },
          { restored: restoredCount, notRestored: [...notRestoredByKey.values()] },
        ),
        edits: selectionEdits,
        undo: null,
      });
      router.refresh();
    });
  }

  function undoProp(undo: OutcomeUndo | null) {
    return undo
      ? { doneAt: undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoing, onUndo: () => runUndo(undo) }
      : null;
  }

  function claim() {
    if (pending || claimKeys.length === 0) return;
    const keys = claimKeys;
    const { singleIds, panels } = splitKeys(keys);
    setRunning("claim");
    start(async () =>
      done(
        "Claimed",
        keys,
        // Every selection — single tests, panels or both — goes through
        // panel-actions.ts: it checks the record budget with every panel
        // counted in full, then mints ONE batch id for the whole call, so a
        // mixed selection has one Undo.
        await claimQueueSelectionAction({
          testRequestIds: singleIds,
          panels: panels.map(({ visitId, groupId }) => ({ visitId, groupId })),
        }),
        false,
        Date.now(),
      ),
    );
  }

  function unclaim() {
    if (pending || unclaimKeys.length === 0) return;
    const keys = unclaimKeys;
    const { singleIds, panels } = splitKeys(keys);
    const items = singleIds.map((key) => ({
      testRequestId: key,
      assignedTo: rowsByKey[key]!.assignedTo!,
    }));
    const heldPanels = panels.map((p) => ({
      ...p,
      members: rowsByKey[p.key]!.bench ?? [],
    }));
    setRunning("unclaim");
    start(async () =>
      done(
        "Unclaimed",
        keys,
        await unclaimQueueSelectionAction({
          items,
          panels: heldPanels.map(({ visitId, groupId, members }) => ({ visitId, groupId, members })),
          reason: reason.trim() || undefined,
        }),
        true,
        Date.now(),
      ),
    );
  }

  function remove() {
    if (pending || deleteKeys.length === 0) return;
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    const keys = deleteKeys;
    const { singleIds, panels } = splitKeys(keys);
    setRunning("delete");
    start(async () =>
      done(
        "Deleted",
        keys,
        await deleteQueueSelectionAction({
          testRequestIds: singleIds,
          panels: panels.map(({ visitId, groupId }) => ({ visitId, groupId })),
          reason: reason.trim(),
        }),
        true,
        Date.now(),
      ),
    );
  }

  // In TESTS, not rows: a chemistry panel row stands for all its members.
  const testsIn = (keys: string[], scope: "bench" | "all") =>
    keys.reduce((n, key) => n + rowTestCount(rowsByKey[key], scope), 0);
  const panelCount =
    panel === "unclaim"
      ? testsIn(unclaimKeys, "bench")
      : panel === "delete"
        ? testsIn(deleteKeys, "all")
        : 0;
  // The rows behind an open panel can vanish under it (a realtime refresh
  // prunes them). Close it then, so it never reopens by itself — with the old
  // reason — over a later, unrelated selection. Render-time adjustment, the
  // same pattern SelectionProvider uses for resetKey.
  // The operator started a new selection (a deliberate toggle/setMany) since
  // this outcome was set — drop it. Post-action pruning (clearKeys) does NOT
  // bump selectionEdits, so a partial action's outcome survives being shown
  // even though rows it acted on were just removed from the selection.
  if (outcome !== null && selectionEdits !== outcome.edits) setOutcome(null);
  if (panel !== null && panelCount === 0) {
    setPanel(null);
    setReason("");
    setErr(null);
  }
  const n = (count: number) => `${count} test${count === 1 ? "" : "s"}`;

  if (count === 0) {
    if (!outcome) return null;
    return (
      <BulkOutcomePanel message={outcome.message} undo={undoProp(outcome.undo)} onDismiss={() => setOutcome(null)} />
    );
  }

  return (
    <BulkBar noun="test">
      {outcome ? (
        <BulkOutcomePanel
          inline
          message={outcome.message}
          undo={undoProp(outcome.undo)}
          onDismiss={() => setOutcome(null)}
        />
      ) : null}
      {claimKeys.length > 0 ? (
        <Button type="button" size="sm" variant="brand" disabled={pending} onClick={claim}>
          {pending && running === "claim" ? "Claiming…" : `Claim (${testsIn(claimKeys, "bench")})`}
        </Button>
      ) : null}
      {unclaimKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-expanded={panel === "unclaim"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "unclaim" ? null : "unclaim");
          }}
        >
          Unclaim ({testsIn(unclaimKeys, "bench")})
        </Button>
      ) : null}
      {deleteKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          aria-expanded={panel === "delete"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "delete" ? null : "delete");
          }}
        >
          Delete ({testsIn(deleteKeys, "all")})
        </Button>
      ) : null}
      {panel !== null && panelCount > 0 ? (
        <div className="basis-full space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
          <p className="text-[color:var(--color-brand-text-mid)]">
            {panel === "unclaim" ? (
              <>
                Put {n(panelCount)} back in the queue for anyone in the section to claim.
                Only possible while no result has been uploaded.
              </>
            ) : (
              <>
                Remove {n(panelCount)} from the queue. Nothing is billed for a deleted
                entry, each can be restored later, and the reason is audit-logged.
              </>
            )}
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closePanel();
            }}
            maxLength={500}
            placeholder={panel === "unclaim" ? "Reason (optional)…" : "Reason (required)…"}
            aria-label={panel === "unclaim" ? "Reason for unclaiming" : "Reason for deleting"}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          {err ? (
            <p role="alert" className="text-red-600">
              {err}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={panel === "unclaim" ? unclaim : remove}
              disabled={pending}
              className={`min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50 ${
                panel === "delete" ? "bg-red-700" : "bg-[color:var(--color-brand-navy)]"
              }`}
            >
              {pending && running === panel
                ? panel === "delete"
                  ? "Deleting…"
                  : "Unclaiming…"
                : panel === "delete"
                  ? `Confirm delete (${panelCount})`
                  : `Confirm unclaim (${panelCount})`}
            </button>
            <button
              type="button"
              onClick={closePanel}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </BulkBar>
  );
}
