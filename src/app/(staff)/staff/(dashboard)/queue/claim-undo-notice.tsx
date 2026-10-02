"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";
import { undoBulkQueueAction } from "./actions";

// Shown on a report or bench page right after the queue row's Claim sent the
// operator here (?claimed=<batch>&at=<ms>): the same 10-minute ↶ Undo the
// bulk bar offers, over the same server action — which re-proves actor,
// window and state, so the batch id in the URL grants nothing by itself.
export function ClaimUndoNotice({
  batchId,
  doneAt,
  reportName,
  open,
}: {
  batchId: string;
  /** Epoch ms of the claim: paces the Undo button and the strip timer. `open` (the server's verdict) gates rendering and an immediate strip. */
  doneAt: number;
  reportName: string;
  /**
   * The server's per-request verdict (`claimUndoOpen` on the page). False
   * renders nothing and strips the query string at once on mount (item 11),
   * even if this client's clock still thinks the window is open — not derived
   * from Date.now() here, which would break render purity.
   */
  open: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState(`You claimed ${reportName}.`);
  const [undoable, setUndoable] = useState(true);

  // Drops ?claimed=&at= (other params kept) so Back never re-shows a stale
  // "You claimed …".
  const stripParams = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("claimed");
    next.delete("at");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  // The effect below calls the latest strip through a ref and depends on
  // doneAt alone, so a searchParams identity change (e.g. the replace itself)
  // can never re-fire replace or re-arm the timer.
  const stripRef = useRef(stripParams);
  useEffect(() => {
    stripRef.current = stripParams;
  }, [stripParams]);

  // Item 11: once the window has closed the notice has nothing to offer, so
  // strip the query string. The server's `open` is authoritative: closed
  // strips at once, whatever this client's clock says. Runs at mount for an
  // already-closed window. After a successful Undo the timer still strips the
  // URL at the 10-minute mark, on purpose, so Back never re-shows the notice.
  // One replace per mount: strippedRef stops a later `open` flip (or a re-armed
  // timer) from stripping a second time.
  const strippedRef = useRef(false);
  useEffect(() => {
    const strip = () => {
      if (strippedRef.current) return;
      strippedRef.current = true;
      stripRef.current();
    };
    const left = doneAt + UNDO_WINDOW_MS - Date.now();
    if (!open || left <= 0) {
      strip();
      return;
    }
    const t = setTimeout(strip, left + 1);
    return () => clearTimeout(t);
  }, [doneAt, open]);

  function onUndo() {
    if (pending) return;
    start(async () => {
      const r = await undoBulkQueueAction({ batchId });
      // Post-await updates go back inside the transition (React 19 keeps only
      // pre-await updates in it) — see src/lib/react/transition-state.test.ts.
      start(() => {
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
          // A passed-through database reason already ends in a full stop.
          const reason = (r.notRestored[0]?.reason ?? "it changed since").replace(/\.$/, "");
          setMessage(`Not undone — ${reason}.`);
        }
      });
    });
  }

  if (!open) return null;

  return (
    <BulkOutcomePanel
      message={message}
      undo={undoable ? { doneAt, windowMs: UNDO_WINDOW_MS, pending, onUndo } : null}
      onDismiss={stripParams}
    />
  );
}
