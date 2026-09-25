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
//
// A form that already holds a select, tick-box or radio in its OWN state
// (`value={x}` / `checked={x}`) is still not safe — see useResetSafeSelect
// below. Swap `<select value=…>` for <ResetSafeSelect> and a controlled
// checkbox or radio for <ResetSafeCheckbox>; props are otherwise unchanged.

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

// A controlled <select> is NOT safe the way a controlled text input is. React
// keeps a text input's value attribute in step with its value, so the form
// reset lands on what was typed — but it never touches an option's
// defaultSelected, so the reset puts the select back on its first/initial
// option while React state still holds the choice. The screen then shows the
// old option and the next Save submits it (a service meant as "Vaccine" saved
// as "Lab test"). This hook does for a select what React does for text: after
// every render it marks the chosen option as the default, and puts the choice
// back if a reset has already moved it.
export function useResetSafeSelect(value: string) {
  const ref = React.useRef<HTMLSelectElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const option of Array.from(el.options)) {
      option.defaultSelected = option.value === value;
    }
    if (el.value !== value && Array.from(el.options).some((o) => o.value === value)) {
      el.value = value;
    }
  });
  return ref;
}

export function StableSelect({ defaultValue = "", ...rest }: SelectBase) {
  const [value, setValue] = React.useState(defaultValue);
  const ref = useResetSafeSelect(value);
  return (
    <select
      {...rest}
      ref={ref}
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

type CheckboxBase = Omit<
  React.ComponentProps<"input">,
  "type" | "checked" | "defaultChecked" | "onChange"
> & { defaultChecked?: boolean; onCheckedChange?: (checked: boolean) => void };

// A tick-box cannot use the controlled trick above. The form reset puts a box
// back to its DOM defaultChecked, and React sets that only once, on mount, for
// a controlled box — so a failed save unticked whatever the user had ticked
// while React state still said "ticked". Left uncontrolled with defaultChecked
// following local state instead, React keeps defaultChecked current and the
// reset lands on the user's choice.
export function StableCheckbox({ defaultChecked = false, onCheckedChange, ...rest }: CheckboxBase) {
  const [checked, setChecked] = React.useState(defaultChecked);
  return (
    <input
      {...rest}
      type="checkbox"
      defaultChecked={checked}
      onChange={(e) => {
        setChecked(e.target.checked);
        onCheckedChange?.(e.target.checked);
      }}
    />
  );
}

// A `<select value={x}>` the parent already controls, made reset-safe. Use it
// where the form needs the value in its own state (a choice that drives other
// fields, a per-row select) and StableSelect would not fit.
export function ResetSafeSelect({
  value,
  ...rest
}: Omit<React.ComponentProps<"select">, "value" | "ref"> & { value: string }) {
  const ref = useResetSafeSelect(value);
  return <select {...rest} ref={ref} value={value} />;
}

// The tick-box / radio counterpart: the form reset puts a box back to its DOM
// defaultChecked, which React sets only on mount for a controlled box. Keep
// defaultChecked in step with `checked` after every render, and put `checked`
// back if a reset has already moved it.
export function useResetSafeChecked(checked: boolean) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.defaultChecked = checked;
    if (el.checked !== checked) el.checked = checked;
  });
  return ref;
}

export function ResetSafeCheckbox({
  checked,
  type = "checkbox",
  ...rest
}: Omit<React.ComponentProps<"input">, "checked" | "type" | "ref"> & {
  checked: boolean;
  type?: "checkbox" | "radio";
}) {
  const ref = useResetSafeChecked(checked);
  return <input {...rest} ref={ref} type={type} checked={checked} />;
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
