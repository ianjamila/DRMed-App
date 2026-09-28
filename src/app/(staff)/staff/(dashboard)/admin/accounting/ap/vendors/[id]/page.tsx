import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getVendorAction } from "@/lib/actions/accounting/vendors";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { listBillPaymentsAction } from "@/lib/actions/accounting/bill-payments";
import { AP_INDEX_MAX_ROWS } from "@/lib/ui/table-params";
import { parseShowVoided, SHOW_VOIDED_PARAM } from "@/lib/accounting/ap-voided-filter";
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const sp = await searchParams;

  const [vendor, bills, payments] = await Promise.all([
    loadVendor(id),
    // Was 100 with nothing on screen saying so, and the KPI cards sum these
    // same rows — the same silent cap the AP indexes had. The client says so
    // on the day a vendor reaches the ceiling.
    listBillsAction({ vendor_id: id, limit: AP_INDEX_MAX_ROWS }),
    listBillPaymentsAction({ vendor_id: id, limit: AP_INDEX_MAX_ROWS }),
  ]);

  if (!vendor.ok || !vendor.data) notFound();

  return (
    <VendorDetailClient
      vendor={vendor.data}
      bills={bills.ok ? bills.data : []}
      payments={payments.ok ? payments.data : []}
      showVoided={parseShowVoided(sp[SHOW_VOIDED_PARAM])}
    />
  );
}
