import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Card } from "@/components/ui/card";
import { buildMonthlyPnl } from "@/lib/operations/trends";
import { OperationsTabs } from "../_components/operations-tabs";
import { PnlTrendChart } from "./_components/pnl-trend-chart";

export default async function OperationsTrendsPage() {
  await requireAdminStaff();

  const admin = createAdminClient();
  const [totalsRes, expenseRes] = await Promise.all([
    admin.from("v_ops_daily_totals").select("business_date, net"),
    admin.from("v_ops_daily_expenses").select("business_date, expense_php"),
  ]);

  if (totalsRes.error || expenseRes.error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the trends data. Please try again.
        </Card>
      </div>
    );
  }

  const data = buildMonthlyPnl(totalsRes.data ?? [], expenseRes.data ?? []);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
      <OperationsTabs />
      <PnlTrendChart data={data} />
    </div>
  );
}
