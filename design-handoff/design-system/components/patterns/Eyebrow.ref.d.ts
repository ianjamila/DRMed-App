import * as React from "react";

export interface EyebrowProps {
  /** Add a trailing rule too (for centered section intros). */
  centered?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Uppercase cyan kicker with a leading rule — the brand's section tag. */
export function Eyebrow(props: EyebrowProps): React.ReactElement;
