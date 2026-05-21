import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { BillFormClient } from "./bill-form-client";

export const metadata = { title: "New bill — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function NewBillPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const [vendorsR, accountsR, cashR, vendorDefaultsR] = await Promise.all([
    listVendorsAction({ active: true }),
    admin
      .from("chart_of_accounts")
      .select("id, code, name")
      .eq("is_active", true)
      .eq("normal_balance", "debit")
      .order("code"),
    admin
      .from("chart_of_accounts")
      .select("id, code, name")
      .eq("is_active", true)
      .like("code", "10__")
      .order("code"),
    admin
      .from("vendors")
      .select("id, default_wt_classification, default_wt_rate, default_account_id")
      .eq("is_active", true),
  ]);

  const vendorDefaults = Object.fromEntries(
    (vendorDefaultsR.data ?? []).map((v) => [v.id, v])
  );

  return (
    <BillFormClient
      mode="create"
      vendors={vendorsR.ok ? vendorsR.data : []}
      vendorDefaults={vendorDefaults}
      allAccounts={accountsR.data ?? []}
      cashAccounts={cashR.data ?? []}
    />
  );
}
