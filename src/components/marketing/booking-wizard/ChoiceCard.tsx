"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Selectable card used for the patient-type and booking-type steps (the
 * bundle's `.bcard`). Icon chip + title + blurb, with a cyan tick that springs
 * in on selection.
 */
export function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  blurb,
}: {
  selected: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: string;
  blurb?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative w-full rounded-[18px] border-[1.5px] bg-white p-[18px] text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-warm-sm)] ${
        selected
          ? "-translate-y-0.5 border-[color:var(--color-brand-cyan)] shadow-[0_0_0_3px_rgba(8,168,226,0.14),var(--shadow-warm-lg)]"
          : "border-[color:var(--color-warm-line)]"
      }`}
    >
      {icon ? (
        <span className="grid h-11 w-11 place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
          {icon}
        </span>
      ) : null}
      <h3 className="mt-3 text-[15.5px] font-bold text-[color:var(--color-brand-navy)]">
        {title}
      </h3>
      {blurb ? (
        <p className="mt-1.5 text-[12.5px] leading-snug text-[color:var(--color-ink-soft)]">
          {blurb}
        </p>
      ) : null}
      <span
        aria-hidden
        className={`absolute right-3 top-3 grid h-[22px] w-[22px] place-items-center rounded-full bg-[color:var(--color-brand-cyan)] text-white transition-all duration-200 ${
          selected ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    </button>
  );
}
