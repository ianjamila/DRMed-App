import * as React from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Red error border + ring. */
  invalid?: boolean;
  /** Options as strings or {value,label} objects. */
  options?: Array<string | SelectOption>;
  /** Disabled first option shown when nothing is selected. */
  placeholder?: string;
}

/** Skinned native select with a custom chevron, matching Input. */
export function Select(props: SelectProps): React.ReactElement;
