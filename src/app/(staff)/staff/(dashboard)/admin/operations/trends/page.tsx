import { requireAdminStaff } from "@/lib/auth/require-admin";
import { EmptyState } from "@/components/ui/empty-state";
import { OperationsTabs } from "../_components/operations-tabs";

export default async function OperationsTrendsPage() {
  await requireAdminStaff();
  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
      <OperationsTabs />
      <EmptyState
        className="mt-6"
        title="Trend charts are coming soon"
        description="Part B2 will add month-over-month trends here. For now, use the Daily report tab for the day-by-day matrix."
      />
    </div>
  );
}
