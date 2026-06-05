import { requireAdminStaff } from "@/lib/auth/require-admin";
import { OperationsTabs } from "../_components/operations-tabs";

export default async function OperationsTrendsPage() {
  await requireAdminStaff();
  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
      <OperationsTabs />
      <div className="mt-6 rounded-lg border bg-white p-8 text-center text-[color:var(--color-brand-text-soft)] shadow-sm">
        <p className="text-sm">Trend charts are coming soon (Part B2).</p>
        <p className="mt-1 text-xs">For now, use the Daily report tab for the day-by-day matrix.</p>
      </div>
    </div>
  );
}
