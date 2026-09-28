"use client";

import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";

export interface OutcomeUndo {
  /** Epoch ms when the action finished; the button hides when the window closes. */
  doneAt: number;
  windowMs: number;
  pending: boolean;
  onUndo: () => void;
}

// What a bulk bar shows after an action, in the bar's own fixed slot: the
// full outcome text (every skipped row named), an optional ↶ Undo that
// disappears when its window closes, and Dismiss. Takes focus when the bar
// that ran the action has just unmounted (focus fell to <body>), so keyboard
// users land on Undo / Dismiss instead of the top of the page.
export function BulkOutcomePanel({
  message,
  undo,
  onDismiss,
}: {
  message: string;
  undo?: OutcomeUndo | null;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, []);

  const open = undo ? now - undo.doneAt < undo.windowMs : false;
  useEffect(() => {
    if (!undo || !open) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [undo, open]);
  const minutesLeft = undo ? Math.max(1, Math.ceil((undo.windowMs - (now - undo.doneAt)) / 60_000)) : 0;

  return (
    <FixedBottomBar>
      <Panel
        ref={ref}
        tabIndex={-1}
        role="status"
        className="flex items-start gap-3 p-3 text-xs shadow-lg"
      >
        <p className="max-h-48 flex-1 overflow-y-auto whitespace-pre-line text-[color:var(--color-brand-text-mid)]">
          {message}
        </p>
        {undo && open ? (
          <button
            type="button"
            onClick={undo.onUndo}
            disabled={undo.pending}
            title={`Available for about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}`}
            className="min-h-[44px] whitespace-nowrap rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 font-semibold text-[color:var(--color-brand-navy)] disabled:opacity-50"
          >
            {undo.pending ? "Undoing…" : "↶ Undo"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 font-semibold"
        >
          Dismiss
        </button>
      </Panel>
    </FixedBottomBar>
  );
}
