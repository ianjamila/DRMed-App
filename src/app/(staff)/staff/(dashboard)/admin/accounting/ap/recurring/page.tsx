import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { listRecurringTemplatesAction } from "@/lib/actions/accounting/recurring-templates";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { RecurringClient } from "./recurring-client";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/ap/recurring"] };
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
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageHeader
            eyebrow={SECTION_NAME["/staff/admin/accounting/ap"]}
            title={ROUTE_NAME["/staff/admin/accounting/ap/recurring"]}
            subtitle="Templates that post a draft bill every month. Each one runs on its next run date, then moves on to the following month."
          />
        </div>
      </div>

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
