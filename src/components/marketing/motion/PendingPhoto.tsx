import { ImageIcon } from "lucide-react";

/**
 * Branded placeholder for the two photo slots awaiting a real shoot (hero inset
 * phlebotomist, portal lifestyle). Renders a navy gradient with a faint ECG
 * pattern, sized by the consumer via `className` so the production photo drops
 * into the exact same box with zero layout shift. See PHOTOS-NEEDED.md.
 */
export function PendingPhoto({
  className,
  label,
}: {
  className?: string;
  /** Optional caption (e.g. the intended subject) shown faintly. */
  label?: string;
}) {
  return (
    <div
      className={`relative flex flex-col items-center justify-center overflow-hidden text-center${className ? ` ${className}` : ""}`}
      style={{
        background:
          "linear-gradient(135deg, var(--color-brand-navy), var(--color-brand-navy-deep))",
      }}
    >
      {/* Faint ECG line motif */}
      <svg
        className="pointer-events-none absolute inset-x-0 top-1/2 h-10 w-full -translate-y-1/2 opacity-[0.22]"
        viewBox="0 0 1200 44"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M0,22 L460,22 478,22 487,8 497,36 507,4 517,38 526,22 548,22 1200,22"
          fill="none"
          stroke="var(--color-brand-cyan-on-navy)"
          strokeWidth={1.4}
        />
      </svg>
      <ImageIcon
        className="relative h-6 w-6 text-[color:var(--color-brand-cyan-on-navy)]"
        aria-hidden="true"
      />
      {label ? (
        <span className="relative mt-2 max-w-[80%] text-[11px] italic leading-snug text-white/55">
          {label}
        </span>
      ) : null}
    </div>
  );
}
