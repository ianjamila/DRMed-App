import { SectionTabs } from "@/components/staff/section-tabs";

const BASE = "/staff/marketing";

const TABS = [
  // Ad performance owns the bare base route; exact keeps it from lighting up
  // on the /ops sibling (same pattern as the AP Overview tab).
  { href: BASE, label: "Ad performance", exact: true },
  { href: `${BASE}/ops`, label: "Ops tracker" },
];

export function MarketingTabs() {
  return <SectionTabs label="Marketing sections" tabs={TABS} />;
}
