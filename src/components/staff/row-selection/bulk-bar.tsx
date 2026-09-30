"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";
import { isTextTarget, useBarFocus } from "./bar-focus";
import { ShortcutsHelp } from "./shortcuts-help";
import { useRowSelection } from "./selection-context";

interface Props {
  /** Singular noun for the count: "booking", "test", "message". */
  noun: string;
  children: ReactNode;
}

// Positioning: see FixedBottomBar.
// Escape clears the selection unless a dialog/sheet is open or focus is in a
// text field.
export function BulkBar({ noun, children }: Props) {
  const { count, clear, refusedCount, limits } = useRowSelection();
  const barRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useBarFocus(barRef, count > 0);
  const clearAndReturn = useCallback(() => {
    restoreFocus();
    clear();
  }, [restoreFocus, clear]);

  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isTextTarget(event.target)) return;
      clearAndReturn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, clearAndReturn]);

  if (count === 0) return null;

  return (
    <FixedBottomBar>
      <Panel
        ref={barRef}
        tabIndex={-1}
        role="region"
        aria-label="Selected rows"
        aria-keyshortcuts="Alt+B"
        className="flex flex-wrap items-center gap-3 p-3 shadow-lg max-sm:[&_button]:h-9"
      >
        <div aria-live="polite" className="text-xs text-[color:var(--color-brand-text-soft)]">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">{count}</span>{" "}
          {noun}
          {count === 1 ? "" : "s"} selected ·{" "}
          <button
            type="button"
            onClick={clearAndReturn}
            className="font-semibold max-sm:min-h-9 max-sm:px-2 hover:underline"
          >
            Clear
          </button>
          {" "}
          <ShortcutsHelp />
          {refusedCount > 0 ? (
            <span className="ml-2 text-amber-700">
              Selected the first {count} — the limit is {limits.rows} rows at a time
            </span>
          ) : null}
        </div>
        <div data-bar-actions className="ml-auto flex flex-wrap items-center gap-2">
          {children}
        </div>
      </Panel>
    </FixedBottomBar>
  );
}
