import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getVendorAction } from "@/lib/actions/accounting/vendors";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { listBillPaymentsAction } from "@/lib/actions/accounting/bill-payments";
import { VendorDetailClient } from "./vendor-detail-client";

// React cache shares this lookup between metadata and the page in one request.
const loadVendor = cache(getVendorAction);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata("Vendor", async () => {
    const result = await loadVendor(id);
    return result.ok ? result.data?.name : null;
  });
}
export const dynamic = "force-dynamic";

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const [vendor, bills, payments] = await Promise.all([
    loadVendor(id),
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
