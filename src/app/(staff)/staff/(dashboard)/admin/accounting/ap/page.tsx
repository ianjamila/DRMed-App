import { ROUTE_NAME } from "@/lib/staff/route-names";
import Link from "next/link";
import { PageHeader } from "@/components/staff/page-header";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getAPDashboardAction } from "@/lib/actions/accounting/ap-dashboard";
import { APDashboardClient } from "./ap-dashboard-client";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/ap"] };
export const dynamic = "force-dynamic";

export default async function APDashboardPage() {
  await requireAdminStaff();
  const r = await getAPDashboardAction();

  return (
    <div className="space-y-6">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        Expenses
      </p>
      <PageHeader
        title={ROUTE_NAME["/staff/admin/accounting/ap"]}
        subtitle="Operating expenses (accounts payable) at a glance: outstanding by aging bucket, draft-rot detector, upcoming recurring runs, top vendors, and withholding tax so far this month."
        actions={
          <Link
            href="/staff/admin/accounting/ap/quick-expense"
            className="inline-flex min-h-11 items-center rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            + Quick expense
          </Link>
        }
      />

      {r.ok ? (
        <APDashboardClient data={r.data} />
      ) : (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {r.error}
        </div>
      )}
    </div>
  );
}
