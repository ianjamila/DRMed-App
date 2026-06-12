import * as React from "react";

export interface ServiceCardProps {
  /** Leading glyph — emoji (matches the live site) or an SVG node. */
  icon?: React.ReactNode;
  /** Service name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Price line, rendered in cyan (e.g. "from ₱550"). */
  price?: string;
  /** Make the whole card a link. */
  href?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Homepage service tile: icon, name, description, cyan price — lifts on hover.
 */
export function ServiceCard(props: ServiceCardProps): React.ReactElement;
