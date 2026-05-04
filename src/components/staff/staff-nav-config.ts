// Sidebar nav items and which roles can see each.
// Used by StaffShell to render a role-filtered list.

import type { StaffSession } from "@/lib/auth/require-staff";

export type StaffRole = StaffSession["role"];

export interface StaffNavItem {
  href: string;
  label: string;
  // The current path is "active" if it equals href OR starts with `${href}/`.
  // Override with a custom matcher when needed (e.g. /staff is too broad).
  exact?: boolean;
  roles: readonly StaffRole[];
}

export interface StaffNavSection {
  heading: string;
  items: StaffNavItem[];
}

export const STAFF_NAV: StaffNavSection[] = [
  {
    heading: "Overview",
    items: [
      {
        href: "/staff",
        label: "Dashboard",
        exact: true,
        roles: ["reception", "medtech", "pathologist", "admin"],
      },
    ],
  },
  {
    heading: "Reception",
    items: [
      {
        href: "/staff/appointments",
        label: "Appointments",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/patients",
        label: "Patients",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/visits/new",
        label: "New visit",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/quote",
        label: "Quick quote",
        roles: ["reception", "medtech", "admin"],
      },
    ],
  },
  {
    heading: "Lab",
    items: [
      {
        href: "/staff/queue",
        label: "Queue",
        roles: ["medtech", "pathologist", "admin"],
      },
      {
        href: "/staff/signoff",
        label: "Sign-off",
        roles: ["pathologist", "admin"],
      },
    ],
  },
  {
    heading: "Admin",
    items: [
      { href: "/staff/admin/prices", label: "Prices", roles: ["admin"] },
      { href: "/staff/services", label: "Services", roles: ["admin"] },
      {
        href: "/staff/admin/closures",
        label: "Closures",
        roles: ["admin"],
      },
      { href: "/staff/users", label: "Staff users", roles: ["admin"] },
      { href: "/staff/audit", label: "Audit log", roles: ["admin"] },
      {
        href: "/staff/admin/import-patients",
        label: "Import patients",
        roles: ["admin"],
      },
    ],
  },
];

export function visibleNavFor(role: StaffRole): StaffNavSection[] {
  return STAFF_NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

export function isItemActive(item: StaffNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
