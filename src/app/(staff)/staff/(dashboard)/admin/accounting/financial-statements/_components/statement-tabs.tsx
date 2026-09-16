"use client";

import { ROUTE_NAME } from "@/lib/staff/route-names";

import { useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/staff/section-tabs";
import { statementPeriodQueries } from "@/lib/reports/statement-period";

const FS = "/staff/admin/accounting/financial-statements";

export function StatementTabs() {
  // M3: three views of one period, so the period must survive a tab change.
  // Not a plain passthrough — the income statement and cash flow take
  // start/end, the balance sheet takes a single as_of closing date, so the
  // selection is mapped explicitly in both directions (see statementPeriodQueries).
  const { range, asOf } = statementPeriodQueries(useSearchParams());

  const tabs = [
    // Income statement lives at the bare route; match it exactly so the
    // balance-sheet / cash-flow sub-routes don't also light it up.
    { href: FS, label: ROUTE_NAME["/staff/admin/accounting/financial-statements"], exact: true, query: range },
    { href: `${FS}/balance-sheet`, label: ROUTE_NAME["/staff/admin/accounting/financial-statements/balance-sheet"], query: asOf },
    { href: `${FS}/cash-flow`, label: ROUTE_NAME["/staff/admin/accounting/financial-statements/cash-flow"], query: range },
  ];

  return <SectionTabs label="Financial Statements" tabs={tabs} />;
}
