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
  visibleNavFor,
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
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold tracking-tight text-[color:var(--color-brand-navy)]"
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
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = isItemActive(item, pathname);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={close}
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
                })}
              </ul>
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
