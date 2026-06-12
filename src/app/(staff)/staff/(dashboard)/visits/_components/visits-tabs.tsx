import { SectionTabs } from "@/components/staff/section-tabs";

const TABS = [
  // Queue is the landing tab of the Visits area — today's live reception
  // worklist (waiting → processing → completed).
  { href: "/staff/visits/queue", label: "Queue" },
  { href: "/staff/visits/new", label: "New visit" },
  {
    // Archive: the bare /staff/visits plus detail drilldowns like
    // /staff/visits/<uuid>, but NOT /staff/visits/new (New visit) or
    // /staff/visits/queue (Queue) — so those don't double-light Archive.
    href: "/staff/visits",
    label: "Archive",
    excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"],
  },
];

export function VisitsTabs() {
  return <SectionTabs label="Visits sections" tabs={TABS} />;
}
