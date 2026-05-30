import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard surface panel — the app's canonical card look
 * (`rounded-xl` + brand-mid border + white surface). Pass padding and any
 * extra classes via `className`; everything else (onClick, etc.) forwards to
 * the underlying div. This consolidates the ~120 hand-rolled
 * `rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white`
 * panels into one primitive.
 *
 * NOTE: This is intentionally NOT the shadcn `Card` (which uses a ring +
 * built-in py/gap + Header/Content structure). Use `Card` for that structured
 * style; use `Panel` for a plain surface container.
 */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white",
        className,
      )}
      {...props}
    />
  );
}
