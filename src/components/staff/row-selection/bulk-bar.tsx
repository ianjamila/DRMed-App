"use client";

import { useEffect, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";
import { useRowSelection } from "./selection-context";

interface Props {
  /** Singular noun for the count: "booking", "test", "message". */
  noun: string;
  children: ReactNode;
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
}

// Positioning: see FixedBottomBar.
// Escape clears the selection unless a dialog/sheet is open or focus is in a
// text field.
export function BulkBar({ noun, children }: Props) {
  const { count, clear, refusedCount, limits } = useRowSelection();

  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isTextTarget(event.target)) return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, clear]);

  if (count === 0) return null;

  return (
    <FixedBottomBar>
      <Panel
        role="region"
        aria-label="Selected rows"
        className="flex flex-wrap items-center gap-3 p-3 shadow-lg max-sm:[&_button]:h-9"
      >
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">{count}</span>{" "}
          {noun}
          {count === 1 ? "" : "s"} selected ·{" "}
          <button
            type="button"
            onClick={clear}
            className="font-semibold max-sm:min-h-9 max-sm:px-2 hover:underline"
          >
            Clear
          </button>
          {refusedCount > 0 ? (
            <span className="ml-2 text-amber-700">
              Selected the first {count} — the limit is {limits.rows} rows at a time
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      </Panel>
    </FixedBottomBar>
  );
}
