// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Eyebrow — the signature uppercase cyan kicker with a short rule.
 * Precedes nearly every section heading on the marketing site.
 */
function Eyebrow({ centered = false, className = "", style = {}, children }) {
  const rule = (
    <span aria-hidden style={{ width: 32, height: 1, background: "var(--color-brand-cyan)", flexShrink: 0 }} />
  );
  return (
    <p
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        margin: 0,
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.18em",
        color: "var(--color-brand-cyan-text, var(--color-brand-cyan))",
        ...style,
      }}
    >
      {rule}
      {children}
      {centered ? rule : null}
    </p>
  );
}
