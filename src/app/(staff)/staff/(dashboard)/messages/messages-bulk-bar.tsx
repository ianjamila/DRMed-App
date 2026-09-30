"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import { formatBulkOutcome } from "@/lib/ui/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import { MESSAGE_BULK_BUTTONS, bulkMessagePlan } from "@/lib/contact-messages/bulk-status";
import type { ContactMessageStatus } from "@/lib/contact-messages/labels";
import { undoMessageStatusManyAction, updateMessageStatusManyAction } from "./actions";

export interface MessageRowInfo {
  /** The sender's name — how the outcome panel names a message. */
  label: string;
  status: ContactMessageStatus;
}

interface OutcomeUndo {
  batchId: string;
  doneAt: number;
  /** Snapshotted: the refresh after the action can drop these rows from the page. */
  labelOf: Record<string, string>;
}

interface Outcome {
  message: string;
  /** selectionEdits when set — a new deliberate edit drops the outcome (same rule as the other bars). */
  edits: number;
  undo: OutcomeUndo | null;
}

const NOUN = { one: "message", many: "messages" };

// Website Messages bulk bar (spec 2026-09-25 §7): the transitions the detail
// page offers, over the eligible subset of the selection; every message not
// changed is named in the outcome, and a 10-minute ↶ Undo reverses the call.
export function MessagesBulkBar({ rowsByKey }: { rowsByKey: Record<string, MessageRowInfo> }) {
  const { state, clearKeys, count, selectionEdits } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [undoing, startUndo] = useTransition();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const selected = [...state.keys()].flatMap((key) =>
    rowsByKey[key] ? [{ key, status: rowsByKey[key].status }] : [],
  );
  const plan = bulkMessagePlan(selected);
  if (outcome !== null && selectionEdits !== outcome.edits) setOutcome(null);

  function run(button: (typeof MESSAGE_BULK_BUTTONS)[number]) {
    const keys = plan[button.to];
    if (keys.length === 0 || pending) return;
    const entries = keys.map((key) => ({ id: key, from: rowsByKey[key]!.status }));
    const labelOf = Object.fromEntries(keys.map((k) => [k, rowsByKey[k]!.label]));
    start(async () => {
      const result = await updateMessageStatusManyAction({ entries, to: button.to });
      if (!result.ok) {
        alert(result.error);
        router.refresh();
        return;
      }
      setOutcome({
        message: formatBulkOutcome({
          verb: button.verb,
          tail: button.tail || undefined,
          noun: NOUN,
          sent: keys.length,
          changed: result.changedIds.length,
          notChanged: result.skipped.map((s) => ({ label: labelOf[s.id] ?? "A message", reason: s.reason })),
        }),
        edits: selectionEdits,
        undo:
          result.batchId && result.changedIds.length > 0
            ? { batchId: result.batchId, doneAt: Date.now(), labelOf }
            : null,
      });
      clearKeys(keys);
      router.refresh();
    });
  }

  function runUndo(u: OutcomeUndo) {
    if (undoing) return;
    const previousMessage = outcome?.message ?? "";
    startUndo(async () => {
      const r = await undoMessageStatusManyAction({ batchId: u.batchId });
      if (!r.ok) {
        const gone = r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY;
        setOutcome({ message: `${r.error}\n\n${previousMessage}`, edits: selectionEdits, undo: gone ? null : u });
        return;
      }
      setOutcome({
        message: undoOutcomeMessage(NOUN, {
          restored: r.restoredIds.length,
          notRestored: r.notRestored.map((n) => ({ label: u.labelOf[n.id] ?? "A message", reason: n.reason })),
        }),
        edits: selectionEdits,
        undo: null,
      });
      router.refresh();
    });
  }

  const undoProp = (undo: OutcomeUndo | null) =>
    undo ? { doneAt: undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoing, onUndo: () => runUndo(undo) } : null;

  if (count === 0) {
    return outcome ? (
      <BulkOutcomePanel message={outcome.message} undo={undoProp(outcome.undo)} onDismiss={() => setOutcome(null)} />
    ) : null;
  }

  return (
    <BulkBar noun="message">
      {outcome ? (
        <BulkOutcomePanel inline message={outcome.message} undo={undoProp(outcome.undo)} onDismiss={() => setOutcome(null)} />
      ) : null}
      {MESSAGE_BULK_BUTTONS.map((button) => {
        const n = plan[button.to].length;
        if (n === 0) return null;
        return (
          <Button key={button.to} type="button" size="sm" variant={button.variant} disabled={pending} onClick={() => run(button)}>
            {button.label} ({n})
          </Button>
        );
      })}
    </BulkBar>
  );
}
