import { fetchCompleteRows } from "@/lib/reports/paging";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { SendOutsClient } from "./send-outs-client";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/cogs/send-outs"] };
export const dynamic = "force-dynamic";

export default async function SendOutsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // Tab 1: Accrued entries with no trueup yet
  const { data: accrued } = await fetchCompleteRows((from, to) =>
    admin
      .from("cogs_send_out_entries")
      .select(
        `
        id, accrued_at, unit_cost_php, test_request_id, service_id, vendor_id,
        services(id, code, name),
        vendors(id, name)
      `
      )
      .is("trueup_id", null)
      .is("voided_at", null)
      .order("accrued_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
  );

  // Tab 2: All trueups ordered newest first
  const { data: trueups, error: completeError } = await fetchCompleteRows((from, to) => admin
    .from("cogs_send_out_trueups")
    .select(
      `
      id, vendor_id, bill_id, period_start_date, period_end_date,
      accrued_total_php, billed_total_php, variance_php, matched_at,
      voided_at, journal_entry_id,
      vendors(id, name)
    `
    )
    .order("matched_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));
  if (completeError) throw new Error(completeError.message);

  // Active vendors for new-trueup dropdown
  const { data: vendors } = await admin
    .from("vendors")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {ROUTE_NAME["/staff/admin/accounting/cogs/send-outs"]}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Accrued send-out costs grouped by vendor, and bill true-up matching
          against Hi Precision invoices.
        </p>
      </header>
      <SendOutsClient
        accrued={accrued ?? []}
        trueups={trueups ?? []}
        vendors={vendors ?? []}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}
