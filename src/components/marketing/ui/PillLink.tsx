import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "cyan" | "navy" | "line" | "lineOnDark";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2 active:translate-y-px";

const sizes: Record<Size, string> = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-3 text-sm sm:text-[15px]",
};

const variants: Record<Variant, string> = {
  // White-on-cyan fails AA, so the cyan CTA carries a dark navy-ink label and
  // flips to navy/white on hover.
  cyan: "bg-[color:var(--color-brand-cyan)] text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] hover:-translate-y-px hover:bg-[color:var(--color-brand-navy)] hover:text-white hover:shadow-[var(--shadow-warm-lg)]",
  navy: "bg-[color:var(--color-brand-navy)] text-white hover:-translate-y-px hover:bg-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-ink)]",
  line: "border border-[color:var(--color-warm-line)] bg-transparent text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-navy)]",
  lineOnDark:
    "border border-white/35 bg-transparent text-white hover:border-white hover:bg-white hover:text-[color:var(--color-brand-navy)]",
};

/**
 * Pill-shaped CTA link — the marketing button. Variants encode the AA-safe
 * color pairings (see comments). Use `line`/`lineOnDark` for secondary actions.
 */
export function PillLink({
  href,
  variant = "cyan",
  size = "md",
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Link>, "href" | "className" | "children">) {
  return (
    <Link
      href={href}
      className={[base, sizes[size], variants[variant], className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </Link>
  );
}
