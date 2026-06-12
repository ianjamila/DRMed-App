import * as React from "react";

export interface StatProps {
  /** The metric, e.g. "19+", "24h", "50%". */
  value: React.ReactNode;
  /** Caption below the value. */
  label: string;
  /** White text for the navy surface. */
  light?: boolean;
  /** @default "left" */
  align?: "left" | "center";
  className?: string;
  style?: React.CSSProperties;
}

/** Single trust metric — extrabold value over a muted label. */
export function Stat(props: StatProps): React.ReactElement;
