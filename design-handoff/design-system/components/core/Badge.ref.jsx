// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

const VARIANTS = {
  default: { background: "var(--color-brand-navy)", color: "#fff" },
  secondary: { background: "var(--color-brand-bg)", color: "var(--color-brand-text)" },
  cyan: { background: "rgba(6,174,241,0.12)", color: "var(--color-brand-navy)" },
  success: { background: "var(--color-success-bg)", color: "var(--color-success-fg)" },
  danger: { background: "rgba(220,38,38,0.10)", color: "var(--color-danger)" },
  warning: { background: "rgba(217,119,6,0.12)", color: "var(--color-warning)" },
  outline: { background: "transparent", color: "var(--color-brand-text-mid)", boxShadow: "inset 0 0 0 1px var(--color-border)" },
};

/**
 * DRMed Badge / status pill — fully rounded, small uppercase-friendly tag.
 * Used for result statuses ("Released"), counts, and metadata chips.
 */
function Badge({ variant = "default", dot = false, className = "", style = {}, children, ...rest }) {
  const v = VARIANTS[variant] || VARIANTS.default;
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 22,
        padding: "0 10px",
        borderRadius: "var(--radius-full)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...v,
        ...style,
      }}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", opacity: 0.8 }}
        />
      ) : null}
      {children}
    </span>
  );
}
