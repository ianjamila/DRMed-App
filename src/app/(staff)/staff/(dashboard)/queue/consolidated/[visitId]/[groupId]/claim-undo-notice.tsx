"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";
import { undoBulkQueueAction } from "../../../actions";

// Shown on a report page right after the queue row's panel Claim sent the
// operator here (?claimed=<batch>&at=<ms>): the same 10-minute ↶ Undo the
// bulk bar offers, over the same server action — which re-proves actor,
// window and state, so the batch id in the URL grants nothing by itself.
export function ClaimUndoNotice({
  batchId,
  doneAt,
  reportName,
}: {
  batchId: string;
  doneAt: number;
  reportName: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState(`You claimed ${reportName}.`);
  const [undoable, setUndoable] = useState(true);

  function onUndo() {
    if (pending) return;
    start(async () => {
      const r = await undoBulkQueueAction({ batchId });
      if (!r.ok) {
        setMessage(r.error);
        if (r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY) setUndoable(false);
        return;
      }
      setUndoable(false);
      if (r.restoredIds.length > 0) {
        setMessage(`Undone — ${reportName} is back in the queue, unclaimed.`);
        router.refresh();
      } else {
        setMessage(`Not undone — ${r.notRestored[0]?.reason ?? "it changed since"}.`);
      }
    });
  }

  return (
    <BulkOutcomePanel
      message={message}
      undo={undoable ? { doneAt, windowMs: UNDO_WINDOW_MS, pending, onUndo } : null}
      onDismiss={() => router.replace(pathname)}
    />
  );
}
