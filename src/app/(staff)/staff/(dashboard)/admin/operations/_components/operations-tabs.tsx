import { SectionTabs } from "@/components/staff/section-tabs";

const BASE = "/staff/admin/operations";

const TABS = [
  { href: BASE, label: "Daily report", exact: true },
  { href: `${BASE}/cash`, label: "Cash & cards" },
  { href: `${BASE}/trends`, label: "Trends" },
];

export function OperationsTabs() {
  return <SectionTabs label="Operations sections" tabs={TABS} />;
}
