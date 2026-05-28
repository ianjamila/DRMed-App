"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS: { href: string; label: string }[] = [
  { href: "/staff/admin/accounting/ap/quick-expense", label: "Quick expense" },
  { href: "/staff/admin/accounting/ap", label: "Overview" },
  { href: "/staff/admin/accounting/ap/bills", label: "Vendor bills" },
  { href: "/staff/admin/accounting/ap/payments", label: "Bill payments" },
  { href: "/staff/admin/accounting/ap/vendors", label: "Vendors" },
  { href: "/staff/admin/accounting/ap/recurring", label: "Recurring" },
];

function isActive(tabHref: string, pathname: string): boolean {
  if (tabHref === "/staff/admin/accounting/ap") {
    // Overview: only when pathname is exactly /ap (not any sub-route).
    return pathname === tabHref || pathname === `${tabHref}/`;
  }
  return pathname === tabHref || pathname.startsWith(`${tabHref}/`);
}

export function BillsTabs() {
  const pathname = usePathname();
  return (
    <nav
      className="-mx-1 flex flex-wrap gap-1 border-b border-[color:var(--color-brand-bg-mid)] pb-3"
      aria-label="Bills sections"
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
