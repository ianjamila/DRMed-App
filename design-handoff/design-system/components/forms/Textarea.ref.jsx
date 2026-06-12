// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Textarea — multi-line counterpart to Input. Same focus ring.
 */
function Textarea({ invalid = false, rows = 4, className = "", style = {}, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <textarea
      rows={rows}
      className={className}
      onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
      onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
      style={{
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        padding: "10px 12px",
        fontFamily: "var(--font-sans)",
        fontSize: 15,
        lineHeight: 1.5,
        color: "var(--color-brand-text)",
        background: "var(--color-white)",
        border: `1px solid ${invalid ? "var(--color-danger)" : focus ? "var(--color-brand-cyan)" : "var(--color-input)"}`,
        borderRadius: "var(--radius-md)",
        outline: "none",
        resize: "vertical",
        boxShadow: focus ? `0 0 0 3px ${invalid ? "rgba(220,38,38,0.18)" : "rgba(6,174,241,0.30)"}` : "none",
        transition: "border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard)",
        ...style,
      }}
      {...rest}
    />
  );
}
