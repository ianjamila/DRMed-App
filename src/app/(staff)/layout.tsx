import type { Metadata } from "next";
import type { ReactNode } from "react";

// Metadata only — no markup. The staff shell (sidebar, header, width) is owned
// by staff/(dashboard)/layout.tsx; this layout exists solely to own the browser
// tab title for every staff route.
//
// WHY HERE, and not on (dashboard)/layout.tsx. The root layout sets
// `template: "%s — drmed.ph"` (src/app/layout.tsx), and until now no staff
// layout overrode it — so every page that hand-wrote its own suffix rendered
// twice: "Accounts Payable — DRMed — drmed.ph", "End of day — staff — drmed.ph".
// The hand-written halves followed four different conventions (— staff,
// — DRMed, — AP — DRMed, — payroll admin) across 140 pages.
//
// (dashboard)/layout.tsx is the wrong enforcement point: it would miss
// /staff/login, /staff/mfa and /staff/payslips, which are staff routes that sit
// outside the dashboard group. This layout is above all of them, so one
// template covers the whole staff surface and a page's `metadata.title` is now
// just the route's own name.
//
// `default` is required: a layout that sets a template must also say what to
// render for segments below it that set no title of their own.
export const metadata: Metadata = {
  title: {
    default: "DRMed staff",
    template: "%s — DRMed staff",
  },
};

export default function StaffTitleLayout({ children }: { children: ReactNode }) {
  return children;
}
