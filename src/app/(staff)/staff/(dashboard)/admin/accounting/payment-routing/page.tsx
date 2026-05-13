import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PaymentRoutingClient } from "./payment-routing-client";

export const metadata = { title: "Payment routing — staff" };
export const dynamic = "force-dynamic";

export default async function PaymentRoutingPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: maps } = await admin
    .from("payment_method_account_map")
    .select("id, payment_method, account_id, notes, updated_at")
    .order("payment_method", { ascending: true });

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code", { ascending: true });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.2 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Payment routing
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            Each payment method routes its cash side of the journal entry to one
            CoA account. Edit a mapping below to change where new payments post.
            Historical journal entries are unaffected.
          </p>
        </div>
      </header>
      <PaymentRoutingClient maps={maps ?? []} accounts={accounts ?? []} />
    </div>
  );
}
