// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";
import { Card } from "../core/Card.ref.jsx";

/**
 * DRMed ServiceCard — icon + name + description + price, the homepage
 * service-grid tile. Lifts on hover. `icon` is any node (emoji glyph
 * matches the live site, or pass an SVG).
 */
function ServiceCard({ icon, name, description, price, href, className = "", style = {} }) {
  const inner = (
    <Card interactive padding={24} className={className} style={{ height: "100%", ...style }}>
      {icon ? (
        <div style={{ fontSize: 30, lineHeight: 1 }} aria-hidden>{icon}</div>
      ) : null}
      <h3
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 700,
          fontSize: 18,
          color: "var(--color-brand-navy)",
          margin: icon ? "16px 0 0" : 0,
        }}
      >
        {name}
      </h3>
      {description ? (
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.6, color: "var(--color-brand-text-soft)" }}>
          {description}
        </p>
      ) : null}
      {price ? (
        <p style={{ margin: "16px 0 0", fontSize: 14, fontWeight: 700, color: "var(--color-brand-cyan-text, var(--color-brand-cyan))" }}>
          {price}
        </p>
      ) : null}
    </Card>
  );
  if (href) {
    return <a href={href} style={{ textDecoration: "none", display: "block", height: "100%" }}>{inner}</a>;
  }
  return inner;
}
