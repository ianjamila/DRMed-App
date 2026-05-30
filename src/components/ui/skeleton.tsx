import type { ComponentProps } from "react";

/** Pulsing placeholder block. Compose with width/height/rounded via className. */
export function Skeleton({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`animate-pulse rounded bg-[color:var(--color-brand-bg-mid)] ${className}`}
      {...props}
    />
  );
}
