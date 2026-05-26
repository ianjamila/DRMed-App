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

// A subgroup sits inside a section and renders as a collapsible
// <details>/<summary>. Used to break up the 30+-item Admin section
// into scan-able buckets (Catalog, Accounting, Payroll, …).
export interface StaffNavSubgroup {
  heading: string;
  items: StaffNavItem[];
}

// A section is either flat (items only) or grouped (subgroups only).
// Mixing both isn't supported — picks one shape per section to keep
// rendering predictable.
export type StaffNavSection =
  | { heading: string; items: StaffNavItem[]; subgroups?: never }
  | { heading: string; subgroups: StaffNavSubgroup[]; items?: never };

export const STAFF_NAV: StaffNavSection[] = [
  {
    heading: "Overview",
    items: [
      {
        href: "/staff",
        label: "Dashboard",
        exact: true,
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
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
        href: "/staff/visits",
        label: "Visit archive",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/quote",
        label: "Quick quote",
        roles: ["reception", "medtech", "admin"],
      },
      {
        href: "/staff/inquiries",
        label: "Inquiries",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/gift-codes/sell",
        label: "Sell gift code",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/payments/cash-drawer",
        label: "Cash drawer",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/payments/eod",
        label: "End of day",
        roles: ["reception", "admin"],
      },
    ],
  },
  {
    heading: "Lab",
    items: [
      {
        href: "/staff/queue",
        label: "Queue",
        roles: ["medtech", "pathologist", "admin", "xray_technician"],
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
    subgroups: [
      {
        heading: "Catalog",
        items: [
          { href: "/staff/admin/prices", label: "Prices", roles: ["admin"] },
          { href: "/staff/services", label: "Services", roles: ["admin"] },
          {
            href: "/staff/admin/result-templates",
            label: "Result templates",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/hmo-providers",
            label: "HMO providers",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/physicians",
            label: "Physicians",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Operations",
        items: [
          {
            href: "/staff/admin/closures",
            label: "Closures",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/gift-codes",
            label: "Gift codes",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/newsletter",
            label: "Newsletter",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Accounting",
        items: [
          {
            href: "/staff/admin/accounting",
            label: "Accounting sync",
            exact: true,
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/chart-of-accounts",
            label: "Chart of accounts",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/periods",
            label: "Accounting periods",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/payment-routing",
            label: "Payment routing",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/cash-routing",
            label: "Cash routing",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/hmo-claims",
            label: "HMO claims",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/hmo-history",
            label: "History import",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Doctor PF",
        items: [
          {
            href: "/staff/admin/accounting/pf-payouts",
            label: "Doctor PF payouts",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/cogs/send-outs",
            label: "Send-out COGS",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Accounts payable",
        items: [
          {
            href: "/staff/admin/accounting/ap",
            label: "AP dashboard",
            exact: true,
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/ap/bills",
            label: "AP bills",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/ap/payments",
            label: "AP payments",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/ap/vendors",
            label: "AP vendors",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/ap/recurring",
            label: "AP recurring",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Payroll",
        items: [
          {
            href: "/staff/admin/payroll/employees",
            label: "Employees",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/periods",
            label: "Pay periods",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/runs",
            label: "Pay runs",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/ot-slips",
            label: "OT slips",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/holidays",
            label: "Holidays",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/rates",
            label: "Statutory rates",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/leaves",
            label: "Leave dashboard",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/settings",
            label: "Payroll settings",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Reports",
        items: [
          {
            href: "/staff/admin/reports/daily-revenue",
            label: "Daily revenue",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/staff-advances",
            label: "Staff advances",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Users & audit",
        items: [
          { href: "/staff/users", label: "Staff users", roles: ["admin"] },
          { href: "/staff/audit", label: "Audit log", roles: ["admin"] },
        ],
      },
      {
        heading: "Patient tools",
        items: [
          {
            href: "/staff/admin/import-patients",
            label: "Import patients",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/patient-merge",
            label: "Merge patients",
            roles: ["admin"],
          },
        ],
      },
    ],
  },
  {
    heading: "Personal",
    items: [
      {
        href: "/staff/profile",
        label: "My profile",
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
      {
        href: "/staff/payslips",
        label: "My payslips",
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
    ],
  },
];

// Filters items inside each section by role, drops empty subgroups, then
// drops sections that ended up with no visible content. Preserves the
// flat-vs-grouped shape so the renderer doesn't have to re-detect it.
export function visibleNavFor(role: StaffRole): StaffNavSection[] {
  const filtered: StaffNavSection[] = [];
  for (const section of STAFF_NAV) {
    if (section.items) {
      const items = section.items.filter((i) => i.roles.includes(role));
      if (items.length > 0) {
        filtered.push({ heading: section.heading, items });
      }
    } else {
      const subgroups = section.subgroups
        .map((g) => ({
          heading: g.heading,
          items: g.items.filter((i) => i.roles.includes(role)),
        }))
        .filter((g) => g.items.length > 0);
      if (subgroups.length > 0) {
        filtered.push({ heading: section.heading, subgroups });
      }
    }
  }
  return filtered;
}

export function isItemActive(item: StaffNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

// True if any item in the subgroup matches the current path. Drives
// the auto-expand behavior so the user's current location is always
// visible without an extra click.
export function isSubgroupActive(
  subgroup: StaffNavSubgroup,
  pathname: string,
): boolean {
  return subgroup.items.some((item) => isItemActive(item, pathname));
}
