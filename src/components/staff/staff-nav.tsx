"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  isItemActive,
  isSectionActive,
  isSubgroupActive,
  visibleNavFor,
  type StaffNavItem,
  type StaffNavSection,
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
  const hasDescription = Boolean(item.description);
  return (
    <Link
      href={item.href}
      // Native browser tooltip on hover. Cheap, accessible, works on touch.
      title={item.description ?? undefined}
      className={cn(
        "group/navlink relative flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-[color:var(--color-brand-navy)] text-white"
          : "text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]",
      )}
    >
      <span className="truncate">{item.label}</span>
      {hasDescription ? (
        <span
          aria-hidden="true"
          className={cn(
            "ml-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none",
            active
              ? "bg-white/25 text-white"
              : "bg-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-text-soft)]",
          )}
        >
          i
        </span>
      ) : null}
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

// The links of a section — flat items first, then any collapsible subgroups.
// Shared by the plain and the collapsible section shells so both render the
// contents identically.
function SectionBody({
  section,
  pathname,
}: {
  section: StaffNavSection;
  pathname: string;
}) {
  const hasItems = Boolean(section.items && section.items.length > 0);
  return (
    <>
      {section.items && section.items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {section.items.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isItemActive(item, pathname)} />
            </li>
          ))}
        </ul>
      ) : null}
      {section.subgroups && section.subgroups.length > 0 ? (
        <div className={`flex flex-col gap-1 ${hasItems ? "mt-2" : ""}`}>
          {section.subgroups.map((group) => (
            <Subgroup key={group.heading} group={group} pathname={pathname} />
          ))}
        </div>
      ) : null}
    </>
  );
}

// A whole section rendered as a collapsed-by-default <details> (partner
// revision 8, "Hidden tabs"). Same auto-expand trick as Subgroup: <details> is
// uncontrolled, so keying on the open state remounts it when the user
// navigates into or out of the section.
function CollapsibleSection({
  section,
  pathname,
}: {
  section: StaffNavSection;
  pathname: string;
}) {
  const containsActive = isSectionActive(section, pathname);
  return (
    <details
      key={`${section.heading}:${containsActive ? "open" : "closed"}`}
      open={containsActive}
      className="group/section"
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 pb-2 pt-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]"
        aria-label={`Toggle ${section.heading}`}
      >
        <span>{section.heading}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 transition-transform group-open/section:rotate-90"
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
      <SectionBody section={section} pathname={pathname} />
    </details>
  );
}

export function StaffNav({ role }: Props) {
  const pathname = usePathname();
  const sections = visibleNavFor(role);

  return (
    <nav className="flex flex-col gap-6">
      {sections.map((section) =>
        section.collapsible ? (
          <CollapsibleSection
            key={section.heading}
            section={section}
            pathname={pathname}
          />
        ) : (
          <div key={section.heading}>
            <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              {section.heading}
            </p>
            <SectionBody section={section} pathname={pathname} />
          </div>
        ),
      )}
    </nav>
  );
}
