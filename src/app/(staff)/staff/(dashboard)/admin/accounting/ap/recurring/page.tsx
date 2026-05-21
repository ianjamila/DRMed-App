import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { listRecurringTemplatesAction } from "@/lib/actions/accounting/recurring-templates";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { RecurringClient } from "./recurring-client";

export const metadata = { title: "Recurring bills — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  await requireAdminStaff();

  const [templates, vendors] = await Promise.all([
    listRecurringTemplatesAction(),
    listVendorsAction({ active: true }),
  ]);

  const admin = createAdminClient();
  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name")
    .eq("is_active", true)
    .eq("normal_balance", "debit")
    .order("code");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.4 · Admin · AP
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Recurring bill templates
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Templates that auto-post draft bills on a monthly cadence. The cron
            handler picks up templates where{" "}
            <code className="rounded bg-gray-100 px-1 text-xs">next_run_date</code> is
            on or before today.
          </p>
        </div>
      </header>

      {templates.ok ? (
        <RecurringClient
          initialTemplates={templates.data}
          vendors={vendors.ok ? vendors.data.map((v) => ({ id: v.id, name: v.name })) : []}
          expenseAccounts={accounts ?? []}
        />
      ) : (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {templates.error}
        </div>
      )}
    </div>
  );
}
