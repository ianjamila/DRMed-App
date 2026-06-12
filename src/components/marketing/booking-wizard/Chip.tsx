"use client";

import type { ReactNode } from "react";

/**
 * Pill toggle used for tests, packages, and time slots (the bundle's `.chip`).
 * Selected → cyan-tinted with a check; disabled → struck through.
 */
export function Chip({
  selected,
  disabled = false,
  onClick,
  children,
  price,
  title,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  price?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      title={title}
      className={`inline-flex min-h-[44px] items-center rounded-full border-[1.5px] px-4 py-2.5 text-left text-[13.5px] font-semibold transition ${
        disabled
          ? "cursor-not-allowed border-[color:var(--color-warm-line)] text-[color:var(--color-ink-soft)] line-through opacity-40"
          : selected
            ? "border-[color:var(--color-brand-cyan)] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-navy)]"
            : "border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-ink-mid)] hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      {selected ? (
        <span aria-hidden className="mr-1 text-[color:var(--color-brand-cyan-text)]">
          ✓
        </span>
      ) : null}
      {children}
      {price ? (
        <span className="ml-1.5 font-[family-name:var(--font-display)] italic font-normal text-[color:var(--color-brand-cyan-text)]">
          {price}
        </span>
      ) : null}
    </button>
  );
}
