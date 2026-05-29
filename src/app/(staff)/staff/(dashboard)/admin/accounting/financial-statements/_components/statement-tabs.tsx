import { SectionTabs } from "@/components/staff/section-tabs";

const FS = "/staff/admin/accounting/financial-statements";

const TABS = [
  // Income statement lives at the bare route; match it exactly so the
  // balance-sheet / cash-flow sub-routes don't also light it up.
  { href: FS, label: "Income statement", exact: true },
  { href: `${FS}/balance-sheet`, label: "Balance sheet" },
  { href: `${FS}/cash-flow`, label: "Cash flow" },
];

export function StatementTabs() {
  return <SectionTabs label="Financial statement sections" tabs={TABS} />;
}
