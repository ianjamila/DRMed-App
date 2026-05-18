import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { CashRoutingClient } from "./cash-routing-client";

export const metadata = { title: "Cash routing — staff" };
export const dynamic = "force-dynamic";

export default async function CashRoutingPage() {
  await requireAdminStaff();
  const admin = createAdminClient();
  const { data: maps } = await admin
    .from("cash_adjustment_account_map")
    .select("id, kind, account_id, requires_user_choice, notes, updated_at")
    .order("kind");
  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code");
  const { data: settings } = await admin
    .from("accounting_settings")
    .select("key, value_php")
    .eq("key", "default_change_fund_php")
    .maybeSingle();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.C · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Cash routing
        </h1>
        <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
          Each cash adjustment kind routes the non-cash side of the journal entry to one
          CoA account. The default change fund is the baseline opening float for every
          business date.
        </p>
      </header>
      <CashRoutingClient
        maps={maps ?? []}
        accounts={accounts ?? []}
        defaultChangeFund={settings?.value_php ?? 0}
      />
    </div>
  );
}
