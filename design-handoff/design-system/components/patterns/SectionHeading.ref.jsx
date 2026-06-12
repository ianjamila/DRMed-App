// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";
import { Eyebrow } from "./Eyebrow.ref.jsx";

/**
 * DRMed SectionHeading — eyebrow + extrabold Montserrat headline with an
 * optional cyan accent fragment. The standard section intro lockup.
 */
function SectionHeading({ eyebrow, title, accent, description, centered = false, light = false, as = "h2", className = "", style = {} }) {
  const Tag = as;
  return (
    <div
      className={className}
      style={{ textAlign: centered ? "center" : "left", maxWidth: centered ? 720 : undefined, marginInline: centered ? "auto" : undefined, ...style }}
    >
      {eyebrow ? <Eyebrow centered={centered}>{eyebrow}</Eyebrow> : null}
      <Tag
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 400,
          fontSize: "clamp(30px, 5vw, 52px)",
          lineHeight: 1.06,
          letterSpacing: "-0.01em",
          color: light ? "#fff" : "var(--color-brand-navy)",
          margin: eyebrow ? "12px 0 0" : 0,
        }}
      >
        {title}
        {accent ? <> <span style={{ color: "var(--color-brand-cyan)", fontStyle: "italic" }}>{accent}</span></> : null}
      </Tag>
      {description ? (
        <p
          style={{
            margin: "16px 0 0",
            marginInline: centered ? "auto" : undefined,
            maxWidth: 640,
            fontSize: 16,
            lineHeight: 1.6,
            color: light ? "rgba(255,255,255,0.72)" : "var(--color-brand-text-mid)",
          }}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
