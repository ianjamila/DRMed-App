"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { signOutStaff } from "@/app/(staff)/staff/login/actions";
import { Button } from "@/components/ui/button";
import {
  CloseIcon,
  HamburgerIcon,
  MobileDrawer,
} from "@/components/ui/mobile-drawer";
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
  email: string;
  fullName: string;
}

const ROLE_LABEL: Record<StaffRole, string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};

function MobileNavLink({
  item,
  active,
  onClick,
}: {
  item: StaffNavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <Link
        href={item.href}
        onClick={onClick}
        className={
          active
            ? "block rounded-md bg-[color:var(--color-brand-navy)] px-3 py-3 text-sm font-medium text-white"
            : "block rounded-md px-3 py-3 text-sm font-medium text-[color:var(--color-brand-text-mid)] transition-colors hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]"
        }
      >
        {item.label}
      </Link>
    </li>
  );
}

function MobileSubgroup({
  group,
  pathname,
  onClick,
}: {
  group: StaffNavSubgroup;
  pathname: string;
  onClick: () => void;
}) {
  const containsActive = isSubgroupActive(group, pathname);
  return (
    <details
      key={`${group.heading}:${containsActive ? "open" : "closed"}`}
      open={containsActive}
      className="group/mobsub"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]">
        <span>{group.heading}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 transition-transform group-open/mobsub:rotate-90"
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
          <MobileNavLink
            key={item.href}
            item={item}
            active={isItemActive(item, pathname)}
            onClick={onClick}
          />
        ))}
      </ul>
    </details>
  );
}

// Mobile-only hamburger + slide-in drawer for the staff portal. Mirrors
// the desktop sidebar's nav so reception can navigate from a phone, and
// closes itself on route change.
export function StaffMobileNavTrigger({ role, email, fullName }: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);

  // Drawer closes via the per-link onClick={close} below; relying on those
  // avoids a setState-in-effect on pathname (lint flags it, and it's
  // redundant since every navigable surface in the drawer already calls
  // close()).

  const sections = visibleNavFor(role);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="grid h-11 w-11 place-items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
      >
        <HamburgerIcon />
      </button>

      <MobileDrawer open={open} onClose={close} label="Staff navigation">
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <Link
            href="/staff"
            onClick={close}
            className="font-heading text-lg font-extrabold tracking-tight text-[color:var(--color-brand-navy)]"
          >
            drmed
            <span className="text-[color:var(--color-brand-cyan)]">.staff</span>
          </Link>
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="grid h-11 w-11 place-items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
          {sections.map((section) => (
            <div key={section.heading}>
              <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                {section.heading}
              </p>
              {section.items && section.items.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((item) => (
                    <MobileNavLink
                      key={item.href}
                      item={item}
                      active={isItemActive(item, pathname)}
                      onClick={close}
                    />
                  ))}
                </ul>
              ) : null}
              {section.subgroups && section.subgroups.length > 0 ? (
                <div className={`flex flex-col gap-1 ${section.items && section.items.length > 0 ? "mt-2" : ""}`}>
                  {section.subgroups.map((group) => (
                    <MobileSubgroup
                      key={group.heading}
                      group={group}
                      pathname={pathname}
                      onClick={close}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>

        <div className="border-t border-[color:var(--color-brand-bg-mid)] p-4">
          <p className="truncate text-sm font-semibold text-[color:var(--color-brand-navy)]">
            {fullName}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {ROLE_LABEL[role]} · {email}
          </p>
          <form action={signOutStaff} className="mt-3">
            <Button type="submit" variant="outline" className="w-full text-xs">
              Sign out
            </Button>
          </form>
        </div>
      </MobileDrawer>
    </>
  );
}
