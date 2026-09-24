"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// One small accessible on/off control, shared by every switch on this page
// (Admin Tools › Email Alerts) rather than each spot hand-rolling its own
// track+thumb div (see src/app/(staff)/staff/(dashboard)/admin/settings/
// online-booking/client.tsx for the one-off version this generalises).
//
// A real <button> so it's keyboard-operable (Enter/Space) with no extra
// wiring; role="switch" + aria-checked tell assistive tech its state;
// focus-visible gives a visible ring; the caller disables it while a save is
// in flight.
export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "type"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "default" | "sm";
}

const SIZES = {
  default: { track: "h-7 w-12", thumb: "h-6 w-6", translate: "translate-x-5" },
  sm: { track: "h-6 w-10", thumb: "h-5 w-5", translate: "translate-x-4" },
} as const;

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  size = "default",
  ...props
}: SwitchProps) {
  const dims = SIZES[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60",
        dims.track,
        checked ? "bg-[color:var(--color-brand-navy)]" : "bg-[color:var(--color-brand-bg-mid)]",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block translate-x-0 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
          dims.thumb,
          checked && dims.translate,
        )}
      />
    </button>
  );
}
