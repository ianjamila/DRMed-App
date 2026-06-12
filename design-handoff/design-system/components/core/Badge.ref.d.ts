import * as React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * @default "default"
   * `default` navy · `secondary` tint · `cyan` accent · `success` emerald
   * (released/paid) · `danger` red · `warning` amber · `outline` hairline.
   */
  variant?: "default" | "secondary" | "cyan" | "success" | "danger" | "warning" | "outline";
  /** Show a leading status dot. */
  dot?: boolean;
  children?: React.ReactNode;
}

/**
 * Fully-rounded status pill for result states, counts, and metadata chips.
 */
export function Badge(props: BadgeProps): React.ReactElement;
