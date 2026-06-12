import type { ReactNode } from "react";

/**
 * Per-step header lockup: a cyan kicker, an Instrument-Serif title, and an
 * optional sub-line, followed by the step body. The slide transition between
 * steps is applied by the parent (a keyed motion wrapper).
 */
export function StepShell({
  kicker,
  title,
  sub,
  children,
}: {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="inline-flex items-center gap-2.5 text-[11.5px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-brand-cyan-text)] before:h-px before:w-[26px] before:bg-[color:var(--color-brand-cyan)] before:content-['']">
        {kicker}
      </p>
      <h1 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(28px,6vw,38px)] font-normal leading-[1.1] text-[color:var(--color-brand-navy)]">
        {title}
      </h1>
      {sub ? (
        <p className="mt-2.5 max-w-[520px] text-[14.5px] text-[color:var(--color-ink-mid)]">
          {sub}
        </p>
      ) : null}
      {children}
    </div>
  );
}
