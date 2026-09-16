import { SECTION_NAME } from "@/lib/staff/route-names";
import { Suspense, type ReactNode } from "react";
import { OperationsTabs } from "./_components/operations-tabs";

// The bar survives every page branch; its client wrapper reads the current period.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <Suspense fallback={null}>
        <OperationsTabs />
      </Suspense>
      <div className="mt-6">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          {SECTION_NAME["/staff/admin/operations"]}
        </p>
        {children}
      </div>
    </div>
  );
}
