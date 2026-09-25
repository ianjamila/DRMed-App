"use client";

import { useEffect, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
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

// Sticky bottom toolbar (visit-page / HMO-claims styling). Rendered as the
// LAST child inside the SelectionProvider so it stays in-flow and sticks to
// the viewport bottom while the tables are in view. Escape clears the
// selection unless a dialog/sheet is open or focus is in a text field.
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
    <Panel
      role="region"
      aria-label="Selected rows"
      className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-3 p-3 shadow-sm"
    >
      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">{count}</span>{" "}
        {noun}
        {count === 1 ? "" : "s"} selected ·{" "}
        <button type="button" onClick={clear} className="font-semibold hover:underline">
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
  );
}
