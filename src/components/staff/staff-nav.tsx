"use client";

import Link from "next/link";
import { Fragment, useId } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NavBadge } from "./nav-badge";
import { NavDivider } from "./nav-divider";
import {
  isItemActive,
  isSectionActive,
  isSubgroupActive,
  itemBadgeCount,
  sectionBadgeTotal,
  subgroupBadgeTotal,
  visibleNavFor,
  type StaffNavItem,
  type StaffNavSection,
  type StaffNavSubgroup,
  type StaffRole,
} from "./staff-nav-config";

interface Props {
  role: StaffRole;
  // Count badges keyed by item href (e.g. `{ "/staff/messages": 3 }`).
  // Optional and additive — an item with no entry renders no badge.
  badges?: Record<string, number>;
}

function NavLink({
  item,
  active,
  badgeCount,
}: {
  item: StaffNavItem;
  active: boolean;
  badgeCount: number;
}) {
  const descriptionId = useId();
  const hasDescription = Boolean(item.description);
  return (
    <div className={cn("relative", active ? "text-white" : "text-[color:var(--color-brand-text-soft)]")}>
      <Link
        href={item.href}
        aria-describedby={hasDescription ? descriptionId : undefined}
        // Same signal SectionTabs gives: screen readers announce the current
        // page, and the styling below is the visual twin of it.
        aria-current={active ? "page" : undefined}
        className={cn(
          "group/navlink relative flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          hasDescription && "pr-11",
          active
            ? "bg-[color:var(--color-brand-navy)] text-white"
            : "text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{item.label}</span>
          <NavBadge count={badgeCount} />
        </span>
      </Link>
      {item.description ? <Tooltip content={item.description} label={`About ${item.label}`} descriptionId={descriptionId} /> : null}
    </div>
  );
}

function Subgroup({
  group,
  pathname,
  badges,
}: {
  group: StaffNavSubgroup;
  pathname: string;
  badges?: Record<string, number>;
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
        <span className="flex items-center gap-2">
          <span>{group.heading}</span>
          <NavBadge count={subgroupBadgeTotal(group, badges)} />
        </span>
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
        {group.items.map((item, i) => (
          <Fragment key={item.href}>
            {item.dividerBefore && i > 0 ? <NavDivider /> : null}
            <li>
              <NavLink
                item={item}
                active={isItemActive(item, pathname)}
                badgeCount={itemBadgeCount(item, badges)}
              />
            </li>
          </Fragment>
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
  badges,
}: {
  section: StaffNavSection;
  pathname: string;
  badges?: Record<string, number>;
}) {
  const hasItems = Boolean(section.items && section.items.length > 0);
  return (
    <>
      {section.items && section.items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {section.items.map((item, i) => (
            <Fragment key={item.href}>
              {item.dividerBefore && i > 0 ? <NavDivider /> : null}
              <li>
                <NavLink
                  item={item}
                  active={isItemActive(item, pathname)}
                  badgeCount={itemBadgeCount(item, badges)}
                />
              </li>
            </Fragment>
          ))}
        </ul>
      ) : null}
      {section.subgroups && section.subgroups.length > 0 ? (
        <div className={`flex flex-col gap-1 ${hasItems ? "mt-2" : ""}`}>
          {section.subgroups.map((group) => (
            <Subgroup key={group.heading} group={group} pathname={pathname} badges={badges} />
          ))}
        </div>
      ) : null}
    </>
  );
}

// A whole section rendered as a collapsed-by-default <details> (partner
// revision 8, "Hidden Tabs"). Same auto-expand trick as Subgroup: <details> is
// uncontrolled, so keying on the open state remounts it when the user
// navigates into or out of the section.
function CollapsibleSection({
  section,
  pathname,
  badges,
}: {
  section: StaffNavSection;
  pathname: string;
  badges?: Record<string, number>;
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
        <span className="flex items-center gap-2">
          <span>{section.heading}</span>
          <NavBadge count={sectionBadgeTotal(section, badges)} />
        </span>
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
      <SectionBody section={section} pathname={pathname} badges={badges} />
    </details>
  );
}

export function StaffNav({ role, badges }: Props) {
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
            badges={badges}
          />
        ) : (
          <div key={section.heading}>
            <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              {section.heading}
            </p>
            <SectionBody section={section} pathname={pathname} badges={badges} />
          </div>
        ),
      )}
    </nav>
  );
}
