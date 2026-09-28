"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import { deleteTestRequestsManyAction } from "@/lib/actions/visits/queue-deletion";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  parsePanelKey,
  splitQueueKeys,
  type BulkQueueResult,
  type QueueRowInfo,
} from "@/lib/queue/bulk-queue";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import { claimTestsAction, unclaimTestsAction, undoBulkQueueAction } from "./actions";

interface Props {
  // Every selectable row the page rendered, keyed by test id OR panel key
  // (owner 2026-09-28: chemistry panel cards are selectable as whole panels).
  rowsByKey: Record<string, QueueRowInfo>;
}

type Panel = null | "unclaim" | "delete";

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
  const unclaimKeys = known(keysByKind[QUEUE_KIND.unclaim]).filter(
    (key) => rowsByKey[key]!.assignedTo !== null,
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
    // Claim, Unclaim and Delete all get Undo — only when the server gave us
    // a batch id and at least one row actually changed.
    const undo: OutcomeUndo | null =
      result.batchId && result.changedIds.length > 0
        ? {
            batchId: result.batchId,
            doneAt,
            labelOf: Object.fromEntries(keys.map((key) => [key, rowsByKey[key]?.label ?? "A test"])),
          }
        : null;
    setOutcome({ message: bulkQueueMessage(verb, keys.length, result, rowsByKey), edits: selectionEdits, undo });
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
      // Ids are already unique selection keys (test id or panel key) — no
      // label-based collapsing needed (two unnamed walk-ins, or two same-name
      // patients, must still count as two). The label is only for display;
      // the first reason seen per row wins.
      const restoredCount = new Set(r.restoredIds).size;
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
    const { testIds, panels } = splitQueueKeys(keys);
    setRunning("claim");
    start(async () =>
      done(
        "Claimed",
        keys,
        await claimTestsAction({
          testIds,
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
    const { testIds, panels } = splitQueueKeys(keys);
    const items = testIds.map((key) => ({
      testRequestId: key,
      assignedTo: rowsByKey[key]!.assignedTo!,
    }));
    setRunning("unclaim");
    start(async () =>
      done(
        "Unclaimed",
        keys,
        await unclaimTestsAction({
          items,
          panels: panels.map((p) => ({
            visitId: p.visitId,
            groupId: p.groupId,
            assignedTo: rowsByKey[p.key]!.assignedTo!,
          })),
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
    const { testIds, panels } = splitQueueKeys(keys);
    setRunning("delete");
    start(async () =>
      done(
        "Deleted",
        keys,
        await deleteTestRequestsManyAction({
          testRequestIds: testIds,
          panels: panels.map(({ visitId, groupId }) => ({ visitId, groupId })),
          reason: reason.trim(),
        }),
        true,
        Date.now(),
      ),
    );
  }

  const panelCount = panel === "unclaim" ? unclaimKeys.length : panel === "delete" ? deleteKeys.length : 0;
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
  // A selected panel key stands for every bench member it resolves to on the
  // server (weight, not 1), so "N tests" would undercount — say "N selected
  // rows" instead whenever the open panel's selection includes one.
  const panelSelection = panel === "unclaim" ? unclaimKeys : deleteKeys;
  const panelCountLabel = panelSelection.some((key) => parsePanelKey(key) !== null)
    ? `${panelCount} selected row${panelCount === 1 ? "" : "s"}`
    : n(panelCount);

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
          {pending && running === "claim" ? "Claiming…" : `Claim (${claimKeys.length})`}
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
          Unclaim ({unclaimKeys.length})
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
          Delete ({deleteKeys.length})
        </Button>
      ) : null}
      {panel !== null && panelCount > 0 ? (
        <div className="basis-full space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
          <p className="text-[color:var(--color-brand-text-mid)]">
            {panel === "unclaim" ? (
              <>
                Put {panelCountLabel} back in the queue for anyone in the section to claim.
                Only possible while no result has been uploaded.
              </>
            ) : (
              <>
                Remove {panelCountLabel} from the queue. Nothing is billed for a deleted
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
