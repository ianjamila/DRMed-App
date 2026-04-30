"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  isItemActive,
  visibleNavFor,
  type StaffRole,
} from "./staff-nav-config";

interface Props {
  role: StaffRole;
}

export function StaffNav({ role }: Props) {
  const pathname = usePathname();
  const sections = visibleNavFor(role);

  return (
    <nav className="flex flex-col gap-6">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            {section.heading}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isItemActive(item, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-[color:var(--color-brand-navy)] text-white"
                        : "text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
