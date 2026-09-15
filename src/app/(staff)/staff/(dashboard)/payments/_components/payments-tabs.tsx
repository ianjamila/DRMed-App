"use client";

import { useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/staff/section-tabs";
import { carryParams } from "@/lib/reports/statement-period";

// Cash drawer is first so it's the default landing tab (nav points here too).
const TABS = [
  { href: "/staff/payments/cash-drawer", label: "Cash drawer" },
  { href: "/staff/payments/eod", label: "End of day" },
];

export function PaymentsTabs() {
  // Carry the date/shift selection across tabs so reception can open the
  // drawer for a given day and close it out without re-picking the date.
  const query = carryParams(useSearchParams(), ["date", "shift"], {
    unvalidated: ["shift"],
  });

  return <SectionTabs label="Cash sections" tabs={TABS} query={query} />;
}
