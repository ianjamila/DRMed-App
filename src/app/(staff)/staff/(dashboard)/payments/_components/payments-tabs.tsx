"use client";

import { useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/staff/section-tabs";
import { carryParams } from "@/lib/reports/statement-period";

// Cash Drawer is first so it's the default landing tab (the sidebar's one
// "Cash Drawer" item points here and stays lit on all three tabs via
// activePrefixes). Petty Cash sits in the middle: it is the same physical till
// — every entry lowers the drawer's expected cash — so it is a view of the
// drawer, not a separate page (sidebar cleanup, 2026-09-15).
const TABS = [
  { href: "/staff/payments/cash-drawer", label: "Cash Drawer" },
  { href: "/staff/payments/petty-cash", label: "Petty Cash" },
  { href: "/staff/payments/eod", label: "End of Day" },
];

export function PaymentsTabs() {
  // Carry the date/shift selection across tabs so reception can open the
  // drawer for a given day and close it out without re-picking the date.
  // Petty Cash reads only `date`; the extra `shift` is harmless there and
  // keeps the round trip drawer → petty cash → drawer lossless.
  const query = carryParams(useSearchParams(), ["date", "shift"], {
    unvalidated: ["shift"],
  });

  return <SectionTabs label="Cash sections" tabs={TABS} query={query} />;
}
