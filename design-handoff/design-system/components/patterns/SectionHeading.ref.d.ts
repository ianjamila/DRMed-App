import * as React from "react";

export interface SectionHeadingProps {
  /** Cyan eyebrow kicker above the title. */
  eyebrow?: string;
  /** Main headline (navy, extrabold). */
  title: string;
  /** Optional fragment appended in cyan. */
  accent?: string;
  /** Supporting paragraph below. */
  description?: string;
  /** Center-align (adds trailing eyebrow rule, centers text). */
  centered?: boolean;
  /** White text — for use on the navy surface. */
  light?: boolean;
  /** Heading tag. @default "h2" */
  as?: "h1" | "h2" | "h3";
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Eyebrow + extrabold headline (with cyan accent) + description — the
 * standard section intro lockup across the marketing site.
 */
export function SectionHeading(props: SectionHeadingProps): React.ReactElement;
