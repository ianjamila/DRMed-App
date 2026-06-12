// NOTE: handoff reference copy — `export` keywords stripped so the source
// project’s design-system compiler doesn’t double-register these files.
// Restore `export` (and plain .jsx names) to import them directly.
import React from "react";

/**
 * DRMed Select — styled native <select> with a custom chevron.
 * Keeps the platform dropdown for accessibility; only the trigger is
 * skinned to match Input.
 */
function Select({ invalid = false, options = [], placeholder, className = "", style = {}, children, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <select
        className={className}
        onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
        style={{
          height: 44,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 38px 0 12px",
          appearance: "none",
          WebkitAppearance: "none",
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          color: "var(--color-brand-text)",
          background: "var(--color-white)",
          border: `1px solid ${invalid ? "var(--color-danger)" : focus ? "var(--color-brand-cyan)" : "var(--color-input)"}`,
          borderRadius: "var(--radius-md)",
          outline: "none",
          cursor: "pointer",
          boxShadow: focus ? "0 0 0 3px rgba(6,174,241,0.30)" : "none",
          transition: "border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard)",
          ...style,
        }}
        {...rest}
      >
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((o) => {
          const value = typeof o === "string" ? o : o.value;
          const label = typeof o === "string" ? o : o.label;
          return <option key={value} value={value}>{label}</option>;
        })}
        {children}
      </select>
      <span
        aria-hidden
        style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--color-brand-text-soft)" }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    </div>
  );
}
