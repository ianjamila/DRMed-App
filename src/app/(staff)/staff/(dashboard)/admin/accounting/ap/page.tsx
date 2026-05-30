import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getAPDashboardAction } from "@/lib/actions/accounting/ap-dashboard";
import { APDashboardClient } from "./ap-dashboard-client";

export const metadata = { title: "Accounts Payable — DRMed" };
export const dynamic = "force-dynamic";

export default async function APDashboardPage() {
  await requireAdminStaff();
  const r = await getAPDashboardAction();

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Bills overview
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Operating-expense AP at a glance: outstanding by aging bucket,
          draft-rot detector, upcoming recurring runs, top vendors, and
          withholding tax so far this month.
        </p>
      </header>

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
