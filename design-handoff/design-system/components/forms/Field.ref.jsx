// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Field — label + control + hint/error wrapper. Pass the control
 * (Input, Textarea, Select) as children.
 */
function Field({ label, htmlFor, hint, error, required = false, className = "", style = {}, children }) {
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label ? (
        <label
          htmlFor={htmlFor}
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-brand-text)",
          }}
        >
          {label}
          {required ? <span style={{ color: "var(--color-danger)", marginLeft: 3 }}>*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--color-danger)" }}>{error}</p>
      ) : hint ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-brand-text-soft)" }}>{hint}</p>
      ) : null}
    </div>
  );
}
