import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { createClient } from "@/lib/supabase/server";
import { loadPartnerLabs } from "@/lib/accounting/partner-labs.server";
import { QuickExpenseForm } from "./quick-expense-form";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/ap/quick-expense"] };
export const dynamic = "force-dynamic";

export default async function QuickExpensePage() {
  await requireAdminStaff();
  const today = todayManilaISODate();

  const supabase = await createClient();
  const partnerLabs = await loadPartnerLabs(supabase);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <PageHeader
          eyebrow={SECTION_NAME["/staff/admin/accounting/ap"]}
          title={ROUTE_NAME["/staff/admin/accounting/ap/quick-expense"]}
          subtitle={<>Record an expense that was already paid (cash, GCash, BPI, or the owner&apos;s own pocket). Posts a
          balanced journal entry in one step — no vendor account, no due date.
          For invoices with a due date, use{" "}
          <strong>Vendor bills</strong> instead.</>}
        />
      </div>

      <QuickExpenseForm defaultDate={today} partnerLabs={partnerLabs} />
    </div>
  );
}
