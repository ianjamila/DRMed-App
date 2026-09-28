"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Viewport-fixed bottom slot for every staff selection / action bar.
// `sticky` can't work here: the staff shell's <main> is deliberately
// `overflow-x-auto` so wide tables scroll on screen (staff-shell.tsx), and
// setting overflow-x on an element makes the browser compute overflow-y too
// — so <main> becomes the scroll container sticky resolves against, and
// since <main> itself never scrolls (the window does), a sticky bar just sits
// at the bottom of its content instead of tracking the viewport. Fixing it to
// the viewport (offset past the md:w-64 sidebar) sidesteps that. An in-flow
// spacer — sized to the fixed bar's live border-box height via
// ResizeObserver, since the bar wraps to several lines on narrow screens —
// keeps the last rows from being covered. z-30 must stay under any
// dialog/sheet overlay (z-50 in dialog.tsx/sheet.tsx, z-[70] in
// confirm-dialog.tsx) so opening one on top of a selection still works.
// Mount it only while the bar should show (callers render it conditionally),
// so the spacer disappears with it.
export function FixedBottomBar({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSpacerHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div aria-hidden="true" style={{ height: spacerHeight }} />
      <div
        ref={wrapperRef}
        className="fixed inset-x-0 bottom-0 z-30 px-4 pb-3 md:left-64 print:hidden"
      >
        <div className="mx-auto w-full max-w-screen-2xl">{children}</div>
      </div>
    </>
  );
}
