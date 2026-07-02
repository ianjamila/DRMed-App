import type { ReactNode } from "react";
import { MarketingTabs } from "./_components/marketing-tabs";

// Owns the shared container + the tab bar for both marketing pages, so the
// tabs sit at the same width and vertical position on each (same model as
// admin/accounting/ap/layout.tsx). Only the body below the bar swaps.
export default function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <MarketingTabs />
      <div className="mt-6">{children}</div>
    </div>
  );
}
