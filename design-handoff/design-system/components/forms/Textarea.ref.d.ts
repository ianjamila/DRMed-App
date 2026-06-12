import * as React from "react";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Red error border + ring. */
  invalid?: boolean;
}

/** Multi-line text field matching Input's focus treatment. */
export function Textarea(props: TextareaProps): React.ReactElement;
