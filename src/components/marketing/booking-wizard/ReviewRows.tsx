"use client";

import { useEffect, useState } from "react";

export interface ReviewRow {
  label: string;
  value: string;
  sub?: string;
  /** When provided, an "Edit" button jumps back to the owning step. */
  onEdit?: () => void;
}

/**
 * Key/value summary on the Review step (the bundle's `.review` cascade). Rows
 * fade up in sequence on mount via the `wizard-casc` class (globals.css).
 */
export function ReviewRows({ rows }: { rows: ReviewRow[] }) {
  // Reveal the cascade after mount (rows start hidden under no-reduced-motion).
  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={`wizard-casc mt-5 overflow-hidden rounded-[18px] border border-[color:var(--color-warm-line-soft)] ${go ? "go" : ""}`}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-start justify-between gap-3.5 border-b border-[color:var(--color-warm-line-soft)] px-[18px] py-3.5 last:border-b-0"
        >
          <div className="w-[110px] flex-shrink-0 pt-0.5 text-xs font-bold uppercase tracking-[0.07em] text-[color:var(--color-ink-soft)]">
            {row.label}
          </div>
          <div className="flex-1 text-[14.5px] text-[color:var(--color-ink)]">
            {row.value}
            {row.sub ? (
              <small className="block text-[12.5px] text-[color:var(--color-ink-soft)]">
                {row.sub}
              </small>
            ) : null}
          </div>
          {row.onEdit ? (
            <button
              type="button"
              onClick={row.onEdit}
              className="px-1 py-0.5 text-[12.5px] font-bold text-[color:var(--color-brand-cyan-text)] hover:underline"
            >
              Edit
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
