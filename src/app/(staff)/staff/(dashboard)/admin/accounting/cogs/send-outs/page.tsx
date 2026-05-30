import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { SendOutsClient } from "./send-outs-client";

export const metadata = { title: "Send-out COGS — DRMed" };
export const dynamic = "force-dynamic";

export default async function SendOutsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // Tab 1: Accrued entries with no trueup yet
  const { data: accrued } = await admin
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
    .order("accrued_at", { ascending: false });

  // Tab 2: All trueups ordered newest first
  const { data: trueups } = await admin
    .from("cogs_send_out_trueups")
    .select(
      `
      id, vendor_id, bill_id, period_start_date, period_end_date,
      accrued_total_php, billed_total_php, variance_php, matched_at,
      voided_at, journal_entry_id,
      vendors(id, name)
    `
    )
    .order("matched_at", { ascending: false });

  // Active vendors for new-trueup dropdown
  const { data: vendors } = await admin
    .from("vendors")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.5 · Admin · Accounting
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Send-out COGS
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
