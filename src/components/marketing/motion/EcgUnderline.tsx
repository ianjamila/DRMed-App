"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const UNDERLINE_PATH =
  "M2,10 L70,9 82,9 88,3 94,14 100,2 106,13 112,9 124,9 198,8";

/**
 * Wraps a word/phrase with a hand-drawn cyan ECG underline that draws itself in
 * after mount (stroke-dashoffset transition). Reduced-motion shows it fully
 * drawn with no animation (handled in globals.css). The wrapper is inline so it
 * sits inside a headline; pass `italic` via className to match the editorial
 * serif accent.
 */
export function EcgUnderline({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => pathRef.current?.classList.add("is-drawn"));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span className={`relative inline-block whitespace-nowrap${className ? ` ${className}` : ""}`}>
      {children}
      <svg
        className="pointer-events-none absolute left-0 -bottom-[0.1em] h-[0.2em] w-full overflow-visible"
        viewBox="0 0 200 16"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path ref={pathRef} className="drmed-uline-path" pathLength={1} d={UNDERLINE_PATH} />
      </svg>
    </span>
  );
}
