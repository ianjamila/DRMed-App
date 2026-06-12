import * as React from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style.
   * - `brand`  navy fill warming to cyan on hover (default workhorse on light surfaces)
   * - `cta`    cyan fill with navy-ink label (AA), darkening to navy — the "Book Now" call-to-action
   * - `navy`   solid navy (use inside dark sections)
   * - `outline` 2px navy border on white, inverts on hover
   * - `secondary` soft tint fill
   * - `ghost`  transparent until hover
   * - `success` emerald (paid / released actions)
   * - `destructive` low-emphasis red
   * - `link`   inline underlined text button
   * @default "brand"
   */
  variant?: "brand" | "cta" | "navy" | "outline" | "secondary" | "ghost" | "success" | "destructive" | "link";
  /** @default "md" */
  size?: "sm" | "md" | "lg" | "touch" | "icon";
  /** Render as an anchor instead of a button. */
  href?: string;
  /** Icon node placed before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon node placed after the label. */
  trailingIcon?: React.ReactNode;
  /** Stretch to fill the container width. */
  fullWidth?: boolean;
  children?: React.ReactNode;
}

/**
 * DRMed primary action control. Navy + cyan brand fills with a subtle
 * lift on hover.
 */
export function Button(props: ButtonProps): React.ReactElement;
