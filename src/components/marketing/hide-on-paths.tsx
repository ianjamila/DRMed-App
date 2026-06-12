"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Renders children except on the given paths — used to give `/schedule` the
 * bundle's focused-funnel layout (no marketing nav/footer/FAB), a purely
 * presentational route-level opt-out (C12). The route + metadata are unchanged.
 */
export function HideOnPaths({
  paths,
  children,
}: {
  paths: string[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  if (paths.includes(pathname)) return null;
  return <>{children}</>;
}
