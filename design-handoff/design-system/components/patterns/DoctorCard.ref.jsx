// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed DoctorCard — physician headshot, name, and specialty tag.
 * Photos sit in a fixed 3:4 frame so a grid stays tidy regardless of
 * source crop.
 */
function DoctorCard({ photo, name, specialty, subtitle, className = "", style = {} }) {
  return (
    <div
      className={className}
      style={{
        background: "var(--color-white)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--ring-card)",
        overflow: "hidden",
        ...style,
      }}
    >
      <div style={{ aspectRatio: "3 / 4", background: "var(--color-brand-bg)", overflow: "hidden" }}>
        {photo ? (
          <img src={photo} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center" }} />
        ) : null}
      </div>
      <div style={{ padding: 16 }}>
        {specialty ? (
          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-brand-cyan-text, var(--color-brand-cyan))" }}>
            {specialty}
          </p>
        ) : null}
        <h3 style={{ margin: "6px 0 0", fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 15, lineHeight: 1.25, color: "var(--color-brand-navy)" }}>
          {name}
        </h3>
        {subtitle ? (
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--color-brand-text-soft)" }}>{subtitle}</p>
        ) : null}
      </div>
    </div>
  );
}
