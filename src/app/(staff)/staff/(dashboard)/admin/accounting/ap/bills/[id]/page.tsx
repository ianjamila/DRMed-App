import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { pluckOne } from "@/lib/reports/format";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBillAction } from "@/lib/actions/accounting/bills";
import { BillDetailClient } from "./bill-detail-client";

// React cache shares this lookup between metadata and the page in one request.
const loadBill = cache(getBillAction);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata("Bill", async () => {
    const result = await loadBill(id);
    return result.ok ? pluckOne(result.data.vendors)?.name : null;
  });
}
export const dynamic = "force-dynamic";

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const billResult = await loadBill(id);
  if (!billResult.ok || !billResult.data) notFound();

  const admin = createAdminClient();
  const { data: jes } = await admin
    .from("journal_entries")
    .select("id, entry_number, source_kind, status, posting_date")
    .eq("source_id", id)
    .in("source_kind", ["bill_post", "bill_payment"])
    .order("created_at", { ascending: true });

  return <BillDetailClient bill={billResult.data} journalEntries={jes ?? []} />;
}
