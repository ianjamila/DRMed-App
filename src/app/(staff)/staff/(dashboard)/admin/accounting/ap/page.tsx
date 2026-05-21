import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getAPDashboardAction } from "@/lib/actions/accounting/ap-dashboard";
import { APDashboardClient } from "./ap-dashboard-client";

export const metadata = { title: "Accounts Payable — DRMed" };
export const dynamic = "force-dynamic";

export default async function APDashboardPage() {
  await requireAdminStaff();
  const r = await getAPDashboardAction();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Accounts Payable
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Operating-expense AP at a glance: outstanding by aging bucket,
          draft-rot detector, upcoming recurring runs, top vendors,
          WT-Expanded month-to-date.
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
