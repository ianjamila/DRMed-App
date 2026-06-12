import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";

type HeadingTag = "h1" | "h2" | "h3";

/**
 * The standard marketing section intro lockup: an {@link Eyebrow} kicker over an
 * Instrument Serif headline with an optional italic-cyan accent fragment, plus
 * an optional lead paragraph.
 *
 * - `light` flips text to white for navy/dark sections (eyebrow + lead shift to
 *   the AA-on-navy tones).
 * - `centered` centers the lockup and caps its width.
 * - `as` controls the heading level (default h2). `id` lands on the wrapper for
 *   in-page anchors.
 */
export function SectionHeading({
  eyebrow,
  title,
  accent,
  description,
  centered = false,
  light = false,
  as = "h2",
  id,
  className,
  headingClassName,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Italic-cyan fragment appended after the title. */
  accent?: ReactNode;
  description?: ReactNode;
  centered?: boolean;
  light?: boolean;
  as?: HeadingTag;
  id?: string;
  className?: string;
  headingClassName?: string;
}) {
  const Tag = as;
  return (
    <div
      id={id}
      className={[
        centered ? "mx-auto max-w-3xl text-center" : "text-left",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {eyebrow ? (
        <Eyebrow centered={centered} onDark={light}>
          {eyebrow}
        </Eyebrow>
      ) : null}
      <Tag
        className={[
          "font-[family-name:var(--font-display)] text-[clamp(30px,5vw,52px)] font-normal leading-[1.06] tracking-[-0.01em]",
          light ? "text-white" : "text-[color:var(--color-brand-navy)]",
          eyebrow ? "mt-3" : "",
          headingClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {title}
        {accent ? (
          <>
            {" "}
            <span className="italic text-[color:var(--color-brand-cyan)]">
              {accent}
            </span>
          </>
        ) : null}
      </Tag>
      {description ? (
        <p
          className={[
            "mt-4 max-w-2xl text-base leading-relaxed",
            centered ? "mx-auto" : "",
            light ? "text-white/70" : "text-[color:var(--color-ink-mid)]",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
