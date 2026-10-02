"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";

// A clock that is safe to render on the server. The panel can be server-
// rendered (the report page's claim notice), so nothing derived from Date.now()
// may reach the first render or the title would mismatch on hydration.
// useSyncExternalStore gives React a separate server snapshot — the action's
// own doneAt, i.e. "just done, window fully open" — used for the server render
// AND the hydrating client render, after which the real clock takes over.
//
// The clock only runs while there is an Undo to time (item 11). It ticks every
// 15 s (the cadence the minutes label always updated on) and fires once more
// 1 ms after the window closes, then stops — a panel with no Undo, or whose
// window has already passed, keeps no timer at all.
//
// Snapshots are whole seconds so getSnapshot stays stable between ticks, but a
// rounded-down second can land BEFORE closesAt on the closing tick (closesAt
// is rarely second-aligned), which would leave the button up with the timer
// already gone. So once the real clock reaches closesAt the snapshot is
// clamped to closesAt itself: constant (stable), and exactly "window closed".
// Rounding is always down, never up, so the button is never hidden early.
const subscribeNever = () => () => {};
const clockNever = () => 0;

function subscribeUntil(closesAt: number) {
  return (onTick: () => void) => {
    if (Date.now() >= closesAt) return () => {};
    const i = setInterval(onTick, 15_000);
    const t = setTimeout(() => {
      clearInterval(i);
      onTick();
    }, closesAt - Date.now() + 1);
    return () => {
      clearInterval(i);
      clearTimeout(t);
    };
  };
}

function clockUntil(closesAt: number) {
  return () => {
    const t = Date.now();
    return t >= closesAt ? closesAt : Math.floor(t / 1000) * 1000;
  };
}

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
  const closesAt = undo ? undo.doneAt + undo.windowMs : null;
  const subscribe = useMemo(() => (closesAt === null ? subscribeNever : subscribeUntil(closesAt)), [closesAt]);
  const getSnapshot = useMemo(() => (closesAt === null ? clockNever : clockUntil(closesAt)), [closesAt]);
  const now = useSyncExternalStore(subscribe, getSnapshot, () => undo?.doneAt ?? 0);

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
