import { Suspense, type ReactNode } from "react";
import { StatementTabs } from "./_components/statement-tabs";

// The bar survives every page branch; its client wrapper reads the current period.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <Suspense fallback={null}>
        <StatementTabs />
      </Suspense>
      <div className="mt-6">
        {children}
      </div>
    </div>
  );
}
