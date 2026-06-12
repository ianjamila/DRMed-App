/**
 * Soft, slowly-drifting cyan/navy radial glow for hero and feature sections.
 * Pure CSS animation (≥8s cycle, transform only); disabled under
 * prefers-reduced-motion and simplified to static below 640px (see globals.css).
 *
 * Position it with the `className` prop (absolute inset offsets). Keep to at
 * most two ambient layers per section per the motion guardrails.
 */
export function AmbientGlow({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`drmed-ambient-glow pointer-events-none absolute${className ? ` ${className}` : ""}`}
      style={{
        background:
          "radial-gradient(closest-side, rgba(8,168,226,0.055), rgba(38,63,145,0.035) 60%, transparent 75%)",
      }}
    />
  );
}
