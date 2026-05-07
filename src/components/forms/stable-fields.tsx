"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// React 19's <form action={...}> integration resets uncontrolled inputs
// after the action returns. Any field that takes a defaultValue and was
// not explicitly wrapped with useState used to clear itself on server-side
// validation errors — losing every keystroke the user had typed.
//
// These wrappers hold the value in local state keyed off `defaultValue`,
// so the rendered DOM is controlled and React preserves the value across
// the action's re-render. Drop-in replacements: keep the same name + form
// data shape, just swap the JSX tag.

type InputBase = Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "defaultValue"
> & { defaultValue?: string };

export function StableInput({ defaultValue = "", ...rest }: InputBase) {
  const [value, setValue] = React.useState(defaultValue);
  return (
    <Input
      {...rest}
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

type SelectBase = Omit<
  React.ComponentProps<"select">,
  "value" | "onChange" | "defaultValue"
> & { defaultValue?: string };

export function StableSelect({ defaultValue = "", ...rest }: SelectBase) {
  const [value, setValue] = React.useState(defaultValue);
  return (
    <select
      {...rest}
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

type TextareaBase = Omit<
  React.ComponentProps<"textarea">,
  "value" | "onChange" | "defaultValue"
> & { defaultValue?: string };

export function StableTextarea({ defaultValue = "", ...rest }: TextareaBase) {
  const [value, setValue] = React.useState(defaultValue);
  return (
    <textarea
      {...rest}
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

interface StableFieldProps extends InputBase {
  label: string;
  // When the form needs an htmlFor target distinct from the input name.
  id?: string;
  wrapperClassName?: string;
}

// Convenience: Label + StableInput in a vertical stack. Matches the local
// `Field` helpers most forms in this repo had.
export function StableField({
  label,
  id,
  name,
  wrapperClassName,
  ...rest
}: StableFieldProps) {
  const fieldId = id ?? name;
  return (
    <div className={cn("grid gap-1.5", wrapperClassName)}>
      <Label htmlFor={fieldId}>{label}</Label>
      <StableInput id={fieldId} name={name} {...rest} />
    </div>
  );
}
