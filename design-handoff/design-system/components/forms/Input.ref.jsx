// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Input — 44px touch-friendly text field. Hairline border that
 * lights up cyan with a soft ring on focus. Set `invalid` for the
 * red error treatment.
 */
function Input({ invalid = false, mono = false, className = "", style = {}, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const ring = invalid ? "var(--color-danger)" : "var(--color-brand-cyan)";
  return (
    <input
      className={className}
      onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
      onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
      style={{
        height: 44,
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        padding: "0 12px",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: 15,
        letterSpacing: mono ? "0.08em" : "normal",
        color: "var(--color-brand-text)",
        background: "var(--color-white)",
        border: `1px solid ${invalid ? "var(--color-danger)" : focus ? ring : "var(--color-input)"}`,
        borderRadius: "var(--radius-md)",
        outline: "none",
        boxShadow: focus ? `0 0 0 3px ${invalid ? "rgba(220,38,38,0.18)" : "rgba(6,174,241,0.30)"}` : "none",
        transition: "border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard)",
        ...style,
      }}
      {...rest}
    />
  );
}
