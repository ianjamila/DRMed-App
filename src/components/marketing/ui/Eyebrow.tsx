import type { ReactNode } from "react";

/**
 * The signature uppercase cyan kicker with a short rule, preceding nearly every
 * marketing section heading. Centered variant adds a trailing rule. On dark
 * surfaces pass `onDark` so the text uses the AA cyan-on-navy step.
 */
export function Eyebrow({
  children,
  centered = false,
  onDark = false,
  className,
}: {
  children: ReactNode;
  centered?: boolean;
  onDark?: boolean;
  className?: string;
}) {
  const rule = (
    <span
      aria-hidden
      className="h-px w-8 shrink-0 bg-[color:var(--color-brand-cyan)]"
    />
  );
  return (
    <p
      className={[
        "inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em]",
        onDark
          ? "text-[color:var(--color-brand-cyan-on-navy)]"
          : "text-[color:var(--color-brand-cyan-text)]",
        centered ? "justify-center" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {rule}
      {children}
      {centered ? rule : null}
    </p>
  );
}
