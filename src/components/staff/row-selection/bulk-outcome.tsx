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

/** How often an open Undo re-reads the clock (the cadence the minutes label always updated on). */
export const OUTCOME_TICK_MS = 15_000;

// A panel with no Undo needs no clock at all: no subscription, constant snapshot.
const subscribeNever = () => () => {};
const clockNever = () => 0;

// While an Undo is open the clock ticks every OUTCOME_TICK_MS and once more
// just after the window closes, so the button goes on time instead of up to a
// tick late. That closing timeout re-arms itself if it fires early (a coarse
// Date.now(), a backwards clock step) and only stops the interval once
// Date.now() has really reached closesAt. A window that is already closed at
// subscribe time keeps no timer, and neither does a panel whose Undo is gone
// (the cleanup clears both).
function subscribeUntil(closesAt: number) {
  return (onTick: () => void) => {
    if (Date.now() >= closesAt) return () => {};
    const interval = setInterval(onTick, OUTCOME_TICK_MS);
    let closing: ReturnType<typeof setTimeout>;
    const arm = () => {
      closing = setTimeout(
        () => {
          if (Date.now() < closesAt) return arm();
          clearInterval(interval);
          onTick();
        },
        Math.max(closesAt - Date.now() + 1, 1),
      );
    };
    arm();
    return () => {
      clearInterval(interval);
      clearTimeout(closing);
    };
  };
}

// Snapshots are whole seconds, which avoids a new value every ms (React would
// re-render on each read). Rounding is always down, so the button is never
// hidden early. But a rounded-down second can land BEFORE closesAt on the
// closing tick (closesAt is rarely second-aligned), leaving the button up with
// the timer gone — so once the real clock reaches closesAt the snapshot is
// clamped to closesAt itself: constant, and exactly "window closed".
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

  // The floored snapshot can sit just BEFORE doneAt right after the action,
  // which would make a 10-minute window read as 11 — never count negative time.
  const elapsed = undo ? Math.max(now, undo.doneAt) - undo.doneAt : 0;
  const open = undo ? elapsed < undo.windowMs : false;
  const minutesLeft = undo ? Math.max(1, Math.ceil((undo.windowMs - elapsed) / 60_000)) : 0;

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
