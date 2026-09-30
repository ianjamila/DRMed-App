"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

interface Shortcut {
  keys: string;
  does: string;
}

// Same four shortcuts for every bulk selection bar — kept in one place so the
// wording can't drift between the kit's BulkBar and the visit page's own
// Tests bar.
const SHORTCUTS: Shortcut[] = [
  { keys: "Alt+B (⌥B on Mac)", does: "Jump to the actions" },
  { keys: "Enter on a checkbox", does: "Jump to the actions" },
  { keys: "Space", does: "Tick or untick a row" },
  { keys: "Esc", does: "Clear the selection (closes this first, if it's open)" },
];

/**
 * A compact "?" affordance on a bulk selection bar (bulk-select follow-ups
 * item 7 part 2): replaces the old "· Alt+B" hint — which only showed on
 * sm+ screens — with a button visible at every width that opens a small
 * popover, positioned ABOVE the bar, listing the bar's keyboard shortcuts.
 * Shared by BulkBar (bulk-bar.tsx) and the visit page's Tests bar
 * (bulk-action-bar.tsx).
 *
 * Escape coordination: while the popover is open, Escape is caught by a
 * CAPTURE-phase `window` listener here — capture runs before any bar's own
 * BUBBLE-phase "Esc clears the selection" listener even reaches the event,
 * so `stopPropagation()` here keeps that key press from ever reaching the
 * bar. The popover just closes; the selection is untouched. Once the
 * popover is closed, a second Escape reaches the bar's own listener as
 * normal and clears the selection — no flag or prop needed on either bar.
 *
 * Placement: render this OUTSIDE a bar's `[data-bar-actions]` container (see
 * bar-focus.ts) — e.g. in the count line, where the old hint lived — so the
 * Alt+B / Enter-on-checkbox jump never lands on the "?" button itself.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stops the key from ever reaching a bar's own (bubble-phase) Escape
      // listener — see the coordination note above.
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyCapture, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, close]);

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white text-xs font-bold text-[color:var(--color-brand-text-soft)] hover:border-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-navy)]"
      >
        ?
      </button>
      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          role="group"
          aria-label="Keyboard shortcuts"
          className="absolute bottom-full left-0 z-40 mb-2 w-64 max-w-[85vw] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-xs shadow-lg"
        >
          <p className="mb-2 font-semibold text-[color:var(--color-brand-navy)]">Keyboard shortcuts</p>
          <dl className="space-y-1.5">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 whitespace-nowrap rounded border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-brand-text-mid)]">
                  {s.keys}
                </dt>
                <dd className="text-right text-[color:var(--color-brand-text-soft)]">{s.does}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </span>
  );
}
