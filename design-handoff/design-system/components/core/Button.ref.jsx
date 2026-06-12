// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Button — the brand's primary action control.
 * Pure CSS-variable styling (no Tailwind, no CSS-in-JS libs) so it
 * renders identically inside the design-system runtime and in exports.
 */
const SIZES = {
  sm: { height: 32, padding: "0 14px", fontSize: 13, radius: "var(--radius-full)", gap: 6 },
  md: { height: 40, padding: "0 20px", fontSize: 14, radius: "var(--radius-full)", gap: 8 },
  lg: { height: 48, padding: "0 28px", fontSize: 15, radius: "var(--radius-full)", gap: 8 },
  touch: { height: 44, padding: "0 22px", fontSize: 15, radius: "var(--radius-full)", gap: 8 },
  icon: { height: 40, width: 40, padding: 0, fontSize: 14, radius: "var(--radius-full)", gap: 0 },
};

const VARIANTS = {
  // Navy fill that warms to cyan on hover — the workhorse on light surfaces.
  brand: { rest: { background: "var(--color-brand-navy)", color: "#fff", boxShadow: "var(--shadow-xs)" }, hover: { background: "var(--color-brand-cyan)" } },
  // Cyan call-to-action — "Book Now". Darkens to navy on hover.
  cta: { rest: { background: "var(--color-brand-cyan)", color: "var(--color-brand-text)", boxShadow: "var(--shadow-sm)" }, hover: { background: "var(--color-brand-navy)", color: "#fff" } },
  // Solid navy, no colour shift — used inside dark sections paired with white.
  navy: { rest: { background: "var(--color-brand-navy)", color: "#fff" }, hover: { background: "var(--color-brand-cyan)" } },
  // Hairline pill outline — secondary CTA ("Meet Our Doctors"). Border darkens to navy on hover.
  outline: { rest: { background: "transparent", color: "var(--color-brand-navy)", border: "1.5px solid var(--color-warm-line, var(--color-border))" }, hover: { border: "1.5px solid var(--color-brand-navy)" } },
  secondary: { rest: { background: "var(--color-brand-bg)", color: "var(--color-brand-text)" }, hover: { background: "var(--color-brand-bg-mid)" } },
  ghost: { rest: { background: "transparent", color: "var(--color-brand-text-mid)" }, hover: { background: "var(--color-brand-bg)", color: "var(--color-brand-navy)" } },
  success: { rest: { background: "var(--color-success)", color: "#fff", boxShadow: "var(--shadow-xs)" }, hover: { background: "#047857" } },
  destructive: { rest: { background: "rgba(220,38,38,0.10)", color: "var(--color-danger)" }, hover: { background: "rgba(220,38,38,0.18)" } },
  link: { rest: { background: "transparent", color: "var(--color-brand-navy)", textDecoration: "underline", textUnderlineOffset: "3px" }, hover: { color: "var(--color-brand-cyan)" } },
};

function Button({
  variant = "brand",
  size = "md",
  type = "button",
  disabled = false,
  href,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  className = "",
  style = {},
  children,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const sz = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.brand;

  const base = {
    display: fullWidth ? "flex" : "inline-flex",
    width: fullWidth ? "100%" : sz.width || undefined,
    height: sz.height,
    padding: sz.padding,
    gap: sz.gap,
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-sans)",
    fontWeight: 700,
    fontSize: sz.fontSize,
    lineHeight: 1,
    whiteSpace: "nowrap",
    borderRadius: sz.radius,
    border: "1px solid transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "background var(--duration-base) var(--ease-standard), color var(--duration-base) var(--ease-standard), transform var(--duration-fast)",
    transform: hover && !disabled ? "translateY(-1px)" : "none",
    textDecoration: "none",
    ...v.rest,
    ...(hover && !disabled ? v.hover : null),
    ...style,
  };

  const content = (
    <>
      {leadingIcon ? <span aria-hidden style={{ display: "inline-flex" }}>{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span aria-hidden style={{ display: "inline-flex" }}>{trailingIcon}</span> : null}
    </>
  );

  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    className,
    style: base,
  };

  if (href && !disabled) {
    return (
      <a href={href} {...handlers} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <button type={type} disabled={disabled} {...handlers} {...rest}>
      {content}
    </button>
  );
}
