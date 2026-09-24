import { ROUTE_NAME } from "@/lib/staff/route-names";
import { SectionTabs } from "@/components/staff/section-tabs";

const BASE = "/staff/marketing";

const TABS = [
  // Ad performance owns the bare base route; exact keeps it from lighting up
  // on the /ops and /sources siblings (same pattern as the AP Overview tab).
  { href: BASE, label: ROUTE_NAME["/staff/marketing"], exact: true },
  { href: `${BASE}/ops`, label: ROUTE_NAME["/staff/marketing/ops"] },
  { href: `${BASE}/sources`, label: ROUTE_NAME["/staff/marketing/sources"] },
];

export function MarketingTabs() {
  return <SectionTabs label="Marketing sections" tabs={TABS} />;
}
