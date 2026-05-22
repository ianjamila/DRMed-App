"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  isItemActive,
  isSubgroupActive,
  visibleNavFor,
  type StaffNavItem,
  type StaffNavSubgroup,
  type StaffRole,
} from "./staff-nav-config";

interface Props {
  role: StaffRole;
}

function NavLink({
  item,
  active,
}: {
  item: StaffNavItem;
  active: boolean;
}) {
  return (
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
  );
}

function Subgroup({
  group,
  pathname,
}: {
  group: StaffNavSubgroup;
  pathname: string;
}) {
  // Auto-expand when the user is on a page inside this group. Keyed on
  // pathname so navigation between sub-pages keeps it open without
  // additional state. Other groups stay collapsed.
  const containsActive = isSubgroupActive(group, pathname);
  return (
    <details
      key={`${group.heading}:${containsActive ? "open" : "closed"}`}
      open={containsActive}
      className="group/subgroup"
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]"
        aria-label={`Toggle ${group.heading}`}
      >
        <span>{group.heading}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 transition-transform group-open/subgroup:rotate-90"
        >
          <path
            d="M4 2l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-2">
        {group.items.map((item) => (
          <li key={item.href}>
            <NavLink item={item} active={isItemActive(item, pathname)} />
          </li>
        ))}
      </ul>
    </details>
  );
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
          {section.items ? (
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isItemActive(item, pathname)} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-1">
              {section.subgroups.map((group) => (
                <Subgroup
                  key={group.heading}
                  group={group}
                  pathname={pathname}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
