import * as React from "react";

export interface FieldProps {
  /** Label text shown above the control. */
  label?: string;
  /** `htmlFor` linking the label to the control id. */
  htmlFor?: string;
  /** Muted helper text below the control. */
  hint?: string;
  /** Error message — replaces the hint and turns red. */
  error?: string;
  /** Append a red asterisk to the label. */
  required?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** The control (Input / Textarea / Select). */
  children?: React.ReactNode;
}

/** Form-row wrapper: label, control, and hint or error message. */
export function Field(props: FieldProps): React.ReactElement;
