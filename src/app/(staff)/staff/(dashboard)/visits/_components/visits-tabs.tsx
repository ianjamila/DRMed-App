"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS: { href: string; label: string }[] = [
  { href: "/staff/visits", label: "Archive" },
  { href: "/staff/visits/new", label: "New visit" },
];

function isActive(tabHref: string, pathname: string): boolean {
  if (tabHref === "/staff/visits") {
    // Archive: matches the bare /staff/visits, not /staff/visits/new
    // (so New visit doesn't double-light). Detail routes like
    // /staff/visits/<uuid> count as Archive since they're drilldowns
    // from the archive table.
    return (
      pathname === tabHref ||
      (pathname.startsWith(`${tabHref}/`) && !pathname.startsWith("/staff/visits/new"))
    );
  }
  return pathname === tabHref || pathname.startsWith(`${tabHref}/`);
}

export function VisitsTabs() {
  const pathname = usePathname();
  return (
    <nav
      className="-mx-1 flex flex-wrap gap-1 border-b border-[color:var(--color-brand-bg-mid)] pb-3"
      aria-label="Visits sections"
    >
      {TABS.map((t) => {
        const active = isActive(t.href, pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-semibold transition-colors",
              active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]",
            )}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
