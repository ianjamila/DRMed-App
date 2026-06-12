import * as React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Red error border + ring. */
  invalid?: boolean;
  /** Monospace + wide tracking — for codes like the DRM-ID / Secure PIN. */
  mono?: boolean;
}

/**
 * 44px text field with a cyan focus ring. Use `mono` for receipt codes.
 */
export function Input(props: InputProps): React.ReactElement;
