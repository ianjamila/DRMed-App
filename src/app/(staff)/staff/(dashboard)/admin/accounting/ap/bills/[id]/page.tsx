import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBillAction } from "@/lib/actions/accounting/bills";
import { BillDetailClient } from "./bill-detail-client";

export const metadata = { title: "Bill — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const billResult = await getBillAction(id);
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
