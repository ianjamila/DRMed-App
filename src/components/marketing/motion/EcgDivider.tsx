/**
 * ECG-pulse section divider: a static heart-rate line with a glowing blip that
 * travels across it. The blip is animated with SMIL (`animateMotion`) so it
 * needs no JS and is hidden under prefers-reduced-motion (see globals.css).
 *
 * Stagger `begin`/`dur` across dividers so the pulses don't march in lockstep.
 */
const ECG_PATH =
  "M0,22 L460,22 478,22 487,8 497,36 507,4 517,38 526,22 548,22 1200,22";

interface EcgDividerProps {
  /** "navy" tints the line/blip for placement on a navy band. */
  variant?: "light" | "navy";
  /** Blip travel duration, seconds. */
  dur?: number;
  /** Blip start offset, seconds. */
  begin?: number;
  className?: string;
}

export function EcgDivider({
  variant = "light",
  dur = 8,
  begin = 1,
  className,
}: EcgDividerProps) {
  return (
    <svg
      className={`drmed-ecg${variant === "navy" ? " drmed-ecg--navy" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 1200 44"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="drmed-ecg-line" d={ECG_PATH} />
      <circle className="drmed-ecg-blip" r={3} opacity={0}>
        <animateMotion
          dur={`${dur}s`}
          begin={`${begin}s`}
          repeatCount="indefinite"
          path={ECG_PATH}
        />
        <animate
          attributeName="opacity"
          values="0;0;1;1;0;0"
          keyTimes="0;0.08;0.18;0.82;0.92;1"
          dur={`${dur}s`}
          begin={`${begin}s`}
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}
