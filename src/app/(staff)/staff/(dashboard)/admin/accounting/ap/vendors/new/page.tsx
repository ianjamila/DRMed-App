import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { VendorFormClient } from "./vendor-form-client";

export const metadata = { title: "New vendor — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function NewVendorPage() {
  await requireAdminStaff();
  const admin = createAdminClient();
  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name")
    .eq("is_active", true)
    .eq("normal_balance", "debit")
    .order("code");
  return <VendorFormClient mode="create" expenseAccounts={accounts ?? []} />;
}
