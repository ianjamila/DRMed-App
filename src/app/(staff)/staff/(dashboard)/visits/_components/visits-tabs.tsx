import { SectionTabs } from "@/components/staff/section-tabs";

const TABS = [
  { href: "/staff/visits/new", label: "New visit" },
  {
    // Archive: the bare /staff/visits plus detail drilldowns like
    // /staff/visits/<uuid>, but NOT /staff/visits/new (so New visit doesn't
    // double-light).
    href: "/staff/visits",
    label: "Archive",
    excludePrefixes: ["/staff/visits/new"],
  },
];

export function VisitsTabs() {
  return <SectionTabs label="Visits sections" tabs={TABS} />;
}
