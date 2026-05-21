import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getVendorAction } from "@/lib/actions/accounting/vendors";
import { VendorFormClient } from "@/app/(staff)/staff/(dashboard)/admin/accounting/ap/vendors/new/vendor-form-client";

export const metadata = { title: "Edit vendor — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function EditVendorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const v = await getVendorAction(id);
  if (!v.ok || !v.data) notFound();

  const admin = createAdminClient();
  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name")
    .eq("is_active", true)
    .eq("normal_balance", "debit")
    .order("code");

  return (
    <VendorFormClient
      mode="edit"
      vendorId={id}
      initial={{
        name: v.data.name ?? "",
        tin: v.data.tin,
        email: v.data.email,
        phone: v.data.phone,
        default_account_id: v.data.default_account_id,
        default_wt_classification: v.data.default_wt_classification,
        default_wt_rate: v.data.default_wt_rate,
        notes: v.data.notes,
      }}
      expenseAccounts={accounts ?? []}
    />
  );
}
