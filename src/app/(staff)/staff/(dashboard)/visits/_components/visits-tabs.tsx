import { SectionTabs } from "@/components/staff/section-tabs";

const TABS = [
  // Reception Queue is the landing tab of the Visits area — today's live
  // reception worklist (waiting → processing → completed). Named in full to
  // disambiguate it from the Lab section's own Queue.
  { href: "/staff/visits/queue", label: "Reception Queue" },
  { href: "/staff/visits/new", label: "New visit" },
  {
    // Archive: the bare /staff/visits plus detail drilldowns like
    // /staff/visits/<uuid>, but NOT /staff/visits/new (New visit) or
    // /staff/visits/queue (Reception Queue) — so those don't double-light Archive.
    href: "/staff/visits",
    label: "Archive",
    excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"],
  },
];

export function VisitsTabs() {
  return <SectionTabs label="Visits sections" tabs={TABS} />;
}
