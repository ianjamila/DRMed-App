import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBillPaymentAction } from "@/lib/actions/accounting/bill-payments";
import { PaymentDetailClient } from "./payment-detail-client";

export const metadata = { title: "Payment — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;

  const r = await getBillPaymentAction(id);
  if (!r.ok || !r.data) notFound();

  // Separate JE side-fetch (mirroring T40's pattern).
  const admin = createAdminClient();
  const { data: jes } = await admin
    .from("journal_entries")
    .select("id, entry_number, source_kind, status, posting_date")
    .eq("source_id", id)
    .eq("source_kind", "bill_payment")
    .order("created_at", { ascending: true });

  return <PaymentDetailClient payment={r.data} journalEntries={jes ?? []} />;
}
