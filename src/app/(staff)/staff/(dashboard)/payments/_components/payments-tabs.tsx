"use client";

import { useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/staff/section-tabs";

// Cash drawer is first so it's the default landing tab (nav points here too).
const TABS = [
  { href: "/staff/payments/cash-drawer", label: "Cash drawer" },
  { href: "/staff/payments/eod", label: "End of day" },
];

export function PaymentsTabs() {
  // Carry the date/shift selection across tabs so reception can open the
  // drawer for a given day and close it out without re-picking the date.
  const params = useSearchParams();
  const next = new URLSearchParams();
  for (const key of ["date", "shift"]) {
    const v = params.get(key);
    if (v) next.set(key, v);
  }
  const query = next.toString() ? `?${next.toString()}` : "";

  return <SectionTabs label="Cash sections" tabs={TABS} query={query} />;
}
