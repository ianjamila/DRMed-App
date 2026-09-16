import { ROUTE_NAME } from "@/lib/staff/route-names";
import { SectionTabs } from "@/components/staff/section-tabs";

const AP = "/staff/admin/accounting/ap";

const TABS = [
  // Overview: only the bare /ap route, not any sub-route.
  { href: AP, label: "Overview", exact: true },
  { href: `${AP}/bills`, label: ROUTE_NAME["/staff/admin/accounting/ap/bills"] },
  { href: `${AP}/payments`, label: ROUTE_NAME["/staff/admin/accounting/ap/payments"] },
  { href: `${AP}/vendors`, label: ROUTE_NAME["/staff/admin/accounting/ap/vendors"] },
  { href: `${AP}/recurring`, label: ROUTE_NAME["/staff/admin/accounting/ap/recurring"] },
];

export function BillsTabs() {
  return <SectionTabs label="Expenses" tabs={TABS} />;
}
