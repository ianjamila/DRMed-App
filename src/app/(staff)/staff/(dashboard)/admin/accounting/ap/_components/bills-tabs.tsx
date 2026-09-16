import { SectionTabs } from "@/components/staff/section-tabs";

const AP = "/staff/admin/accounting/ap";

const TABS = [
  { href: `${AP}/quick-expense`, label: "Quick Expense" },
  // Overview: only the bare /ap route, not any sub-route.
  { href: AP, label: "Overview", exact: true },
  { href: `${AP}/bills`, label: "Vendor Bills" },
  { href: `${AP}/payments`, label: "Bill Payments" },
  { href: `${AP}/vendors`, label: "Vendors" },
  { href: `${AP}/recurring`, label: "Recurring" },
];

export function BillsTabs() {
  return <SectionTabs label="Bills sections" tabs={TABS} />;
}
