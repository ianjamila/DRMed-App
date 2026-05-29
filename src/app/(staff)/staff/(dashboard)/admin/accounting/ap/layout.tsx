import type { ReactNode } from "react";
import { BillsTabs } from "./_components/bills-tabs";

// Owns the shared container + the tab bar for every AP page, so the tabs sit
// at the same width and the same vertical position on all of them. Previously
// each page rendered its own container (max-w varied 3xl–6xl) and its own
// <BillsTabs/> below a page-specific header — switching tabs jumped the layout
// around. With the tabs fixed here, the bar never moves; only the body below
// it swaps.
export default function AccountsPayableLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <BillsTabs />
      <div className="mt-6">{children}</div>
    </div>
  );
}
