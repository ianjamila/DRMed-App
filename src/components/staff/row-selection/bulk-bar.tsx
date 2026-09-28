"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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

// Viewport-fixed bottom toolbar (visit-page / HMO-claims styling). `sticky`
// can't work here: the staff shell's <main> is deliberately
// `overflow-x-auto` so wide tables scroll on screen (staff-shell.tsx), and
// setting overflow-x on an element makes the browser compute overflow-y too
// — so <main> becomes the scroll container sticky resolves against, and
// since <main> itself never scrolls (the window does), the bar just sits at
// the bottom of its content instead of tracking the viewport. Fixing it to
// the viewport (offset past the md:w-64 sidebar) sidesteps that. An in-flow
// spacer below the tables — sized to the fixed bar's live height via
// ResizeObserver, since the bar wraps to multiple lines on narrow screens —
// keeps the last rows from being covered. z-30 must stay under any
// dialog/sheet overlay (z-50 in dialog.tsx/sheet.tsx, z-[70] in
// confirm-dialog.tsx) so opening one on top of a selection still works.
// Escape clears the selection unless a dialog/sheet is open or focus is in a
// text field.
export function BulkBar({ noun, children }: Props) {
  const { count, clear, refusedCount, limits } = useRowSelection();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);

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

  useEffect(() => {
    if (count === 0) return;
    const node = wrapperRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSpacerHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [count]);

  if (count === 0) return null;

  return (
    <>
      <div aria-hidden style={{ height: spacerHeight }} />
      <div
        ref={wrapperRef}
        className="fixed inset-x-0 bottom-0 z-30 px-4 pb-3 md:left-64 print:hidden"
      >
        <div className="mx-auto w-full max-w-screen-2xl">
          <Panel
            role="region"
            aria-label="Selected rows"
            className="flex flex-wrap items-center gap-3 p-3 shadow-lg max-sm:[&_button]:h-9"
          >
            <div className="text-xs text-[color:var(--color-brand-text-soft)]">
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                {count}
              </span>{" "}
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
        </div>
      </div>
    </>
  );
}
