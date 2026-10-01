"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";

// A clock that is safe to render on the server. The panel can be server-
// rendered (the report page's claim notice), so nothing derived from Date.now()
// may reach the first render or the title would mismatch on hydration.
// useSyncExternalStore gives React a separate server snapshot — the action's
// own doneAt, i.e. "just done, window fully open" — used for the server render
// AND the hydrating client render, after which the real clock takes over.
// Whole-second snapshots keep getSnapshot stable between ticks; the 15 s tick
// is the same cadence the minutes label always updated on.
const subscribeToClock = (onTick: () => void) => {
  const t = setInterval(onTick, 15_000);
  return () => clearInterval(t);
};
const clientNow = () => Math.floor(Date.now() / 1000) * 1000;

export interface OutcomeUndo {
  /** Epoch ms when the action finished; the button hides when the window closes. */
  doneAt: number;
  windowMs: number;
  pending: boolean;
  onUndo: () => void;
}

// What a bulk bar shows after an action: the full outcome text (every
// skipped row named), an optional ↶ Undo that disappears when its window
// closes, and Dismiss.
//
// Two placements:
// - `inline` false/omitted (the selection is now empty): the bar itself has
//   unmounted, so this renders in the shared FixedBottomBar slot and takes
//   focus on mount (focus fell to <body>) so keyboard users land on
//   Undo / Dismiss instead of the top of the page.
// - `inline` true (the selection is non-empty again — other rows are still
//   selected): the bar is still showing its buttons, so this renders as a
//   plain full-width block INSIDE it (no FixedBottomBar wrapper, no
//   focus-on-mount — the bar itself already holds focus/position).
export function BulkOutcomePanel({
  message,
  undo,
  onDismiss,
  inline = false,
}: {
  message: string;
  undo?: OutcomeUndo | null;
  onDismiss: () => void;
  inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useSyncExternalStore(subscribeToClock, clientNow, () => undo?.doneAt ?? 0);

  useEffect(() => {
    if (inline) return;
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, [inline]);

  const open = undo ? now - undo.doneAt < undo.windowMs : false;
  const minutesLeft = undo ? Math.max(1, Math.ceil((undo.windowMs - (now - undo.doneAt)) / 60_000)) : 0;

  const content = (
    <Panel
      ref={inline ? undefined : ref}
      tabIndex={inline ? undefined : -1}
      role="status"
      data-bar-outcome
      className={
        inline
          ? "flex basis-full items-start gap-3 p-3 text-xs"
          : "flex items-start gap-3 p-3 text-xs shadow-lg"
      }
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
  );

  if (inline) return content;
  return <FixedBottomBar>{content}</FixedBottomBar>;
}
