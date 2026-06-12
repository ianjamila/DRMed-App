// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Card — the universal content container.
 * Signature look: white surface, 14px radius, a 1px hairline ring
 * (not a heavy border), lifting to a soft cool shadow on hover when
 * `interactive` is set. Compose freely; helper slots below are optional.
 */
function Card({ interactive = false, padding = 24, className = "", style = {}, children, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      className={className}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        background: "var(--color-white)",
        borderRadius: "var(--radius-xl)",
        boxShadow: hover ? "var(--shadow-lg)" : "var(--ring-card)",
        padding,
        transition: "box-shadow var(--duration-base) var(--ease-standard), transform var(--duration-base) var(--ease-standard)",
        transform: hover ? "translateY(-2px)" : "none",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

function CardTitle({ className = "", style = {}, children, ...rest }) {
  return (
    <h3
      className={className}
      style={{
        fontFamily: "var(--font-heading)",
        fontSize: 18,
        fontWeight: 800,
        color: "var(--color-brand-navy)",
        lineHeight: 1.25,
        margin: 0,
        ...style,
      }}
      {...rest}
    >
      {children}
    </h3>
  );
}

function CardDescription({ className = "", style = {}, children, ...rest }) {
  return (
    <p
      className={className}
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: "var(--color-brand-text-soft)",
        margin: "8px 0 0",
        ...style,
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

function CardFooter({ className = "", style = {}, children, ...rest }) {
  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: 18,
        paddingTop: 16,
        borderTop: "1px solid var(--color-brand-bg-mid)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
