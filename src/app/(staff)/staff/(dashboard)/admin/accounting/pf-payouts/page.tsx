import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { PfPayoutsClient } from "./pf-payouts-client";

export const metadata = { title: "Doctor PF Payouts — DRMed" };
export const dynamic = "force-dynamic";

export default async function PfPayoutsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // Tab 1 data: Open — recognized, undisbursed entries
  const { data: openEntries } = await admin
    .from("doctor_pf_entries")
    .select(
      `
      id, pf_php, recognized_at, recognition_basis, physician_id,
      test_request_id, hmo_allocation_id, created_at,
      physicians(id, full_name, compensation_arrangement, is_active)
    `
    )
    .is("disbursement_id", null)
    .is("voided_at", null)
    .not("recognized_at", "is", null)
    .order("recognized_at", { ascending: false });

  // Tab 2 data: Pending HMO settlement
  const { data: pendingHmo } = await admin
    .from("doctor_pf_entries")
    .select(
      `
      id, pf_php, recognition_basis, physician_id, test_request_id, created_at,
      physicians(id, full_name)
    `
    )
    .eq("recognition_basis", "hmo_at_settlement")
    .is("recognized_at", null)
    .is("voided_at", null)
    .order("created_at", { ascending: false });

  // Tab 3 data: History (last 90 days)
  const now = new Date();
  now.setDate(now.getDate() - 90);
  const ninetyDaysAgo = now.toISOString().slice(0, 10);
  const { data: history } = await admin
    .from("doctor_pf_disbursements")
    .select(
      `
      id, batch_number, posted_date, method, total_php, voided_at,
      physicians(id, full_name)
    `
    )
    .gte("posted_date", ninetyDaysAgo)
    .order("posted_date", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.5 · Admin · Accounting
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Doctor PF Payouts
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          End-of-day batch payouts for physician professional fees. Open tab
          shows accrued PFs awaiting disbursement; Pending HMO shows PFs
          deferred to HMO settlement.
        </p>
      </header>
      <PfPayoutsClient
        openEntries={openEntries ?? []}
        pendingHmo={pendingHmo ?? []}
        history={history ?? []}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}
