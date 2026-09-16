"use client";

import { useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/staff/section-tabs";
import { carryParams } from "@/lib/reports/statement-period";

const BASE = "/staff/admin/operations";

const TABS = [
  { href: BASE, label: "Daily Report", exact: true },
  { href: `${BASE}/cash`, label: "Cash & Cards" },
  { href: `${BASE}/expenses`, label: "Expenses & P&L" },
  { href: `${BASE}/hmo`, label: "HMO Receivables" },
  { href: `${BASE}/trends`, label: "Trends" },
];

export function OperationsTabs() {
  // M3: all five tabs are lenses on ONE period, so the period has to survive a
  // tab change — picking March on the Daily report and clicking "Cash & cards"
  // used to land you back on the default year-to-date range. Client component
  // reading the params, like PaymentsTabs; SectionTabs stays param-free so it
  // never triggers the dynamic-render bailout for its other callers.
  //
  // Trends is deliberately all-time and ignores from/to, but still carries them
  // so the range is intact when you tab back out of it.
  const query = carryParams(useSearchParams(), ["from", "to"]);

  return <SectionTabs label="Operations sections" tabs={TABS} query={query} />;
}
