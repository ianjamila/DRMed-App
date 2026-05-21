import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getVendorAction } from "@/lib/actions/accounting/vendors";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { listBillPaymentsAction } from "@/lib/actions/accounting/bill-payments";
import { VendorDetailClient } from "./vendor-detail-client";

export const metadata = { title: "Vendor — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const [vendor, bills, payments] = await Promise.all([
    getVendorAction(id),
    listBillsAction({ vendor_id: id, limit: 100 }),
    listBillPaymentsAction({ vendor_id: id, limit: 100 }),
  ]);

  if (!vendor.ok || !vendor.data) notFound();

  return (
    <VendorDetailClient
      vendor={vendor.data}
      bills={bills.ok ? bills.data : []}
      payments={payments.ok ? payments.data : []}
    />
  );
}
