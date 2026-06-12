// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Stat — a single hero/trust metric: extrabold navy value over a
 * muted label. Used in the hero stat row (19+ Physicians, 24h Turnaround…).
 */
function Stat({ value, label, light = false, align = "left", className = "", style = {} }) {
  return (
    <div className={className} style={{ textAlign: align, ...style }}>
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 800,
          fontSize: 30,
          lineHeight: 1,
          color: light ? "#fff" : "var(--color-brand-navy)",
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 1.3,
          color: light ? "rgba(255,255,255,0.7)" : "var(--color-brand-text-soft)",
        }}
      >
        {label}
      </div>
    </div>
  );
}
