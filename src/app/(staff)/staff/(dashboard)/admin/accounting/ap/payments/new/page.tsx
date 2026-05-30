import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { PaymentFormClient } from "./payment-form-client";

export const metadata = { title: "New payment — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function NewPaymentPage() {
  await requireAdminStaff();

  const admin = createAdminClient();
  const [vendorsR, cashR] = await Promise.all([
    listVendorsAction({ active: true }),
    admin
      .from("chart_of_accounts")
      .select("id, code, name")
      .eq("is_active", true)
      .like("code", "10__")
      .order("code"),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP · Payment
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New payment
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          Pick a vendor, choose which posted/partially-paid bills to settle,
          and confirm the payment method.
        </p>
      </header>

      <PaymentFormClient
        vendors={vendorsR.ok ? vendorsR.data.map((v) => ({ id: v.id, name: v.name })) : []}
        cashAccounts={cashR.data ?? []}
      />
    </div>
  );
}
