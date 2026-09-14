import { SectionTabs } from "@/components/staff/section-tabs";

// Create vs browse — the two halves of the visit *record*, which is what this
// bar was built for. The Reception Queue is deliberately NOT here: it's a live
// day worklist, not a third view of the archive, and it shares /staff/visits
// only by URL accident. It renders no tab bar and is reached from the sidebar
// (Front desk › Reception Queue) with a "+ New visit" action of its own.
const TABS = [
  { href: "/staff/visits/new", label: "New visit" },
  {
    // Visit archive: the bare /staff/visits plus detail drilldowns like
    // /staff/visits/<uuid>, but NOT /staff/visits/new (New visit). /staff/visits/queue
    // stays excluded too: the queue renders no bar today, but the exclusion keeps
    // it from lighting up if one is ever added there or under it.
    href: "/staff/visits",
    label: "Visit archive",
    excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"],
  },
];

export function VisitsTabs() {
  return <SectionTabs label="Visits sections" tabs={TABS} />;
}
