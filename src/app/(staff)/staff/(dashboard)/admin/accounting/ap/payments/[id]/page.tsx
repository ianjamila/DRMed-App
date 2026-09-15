import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBillPaymentAction } from "@/lib/actions/accounting/bill-payments";
import { loadClosedDayContext } from "@/lib/accounting/eod-closed-dates";
import { tillPaymentBlockedByClose } from "@/lib/accounting/till-close-warning";
import { PaymentDetailClient } from "./payment-detail-client";

export const metadata = { title: "Payment" };
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

  // 0149: voiding a till payment updates its cash-drawer row, and the
  // day-close lock guards UPDATE too — so once that business day is closed the
  // void is refused and the whole cascade (reversal JE included) rolls back.
  // A void almost always happens after the payment's own day has been counted,
  // so this is the common case; say it on the page rather than in a dialog the
  // admin has already typed a reason into.
  const closedDays = await loadClosedDayContext();
  const voidBlockedByClose = tillPaymentBlockedByClose({
    cashAccountId: r.data.cash_account_id,
    tillAccountId: closedDays.tillAccountId,
    paymentDate: r.data.payment_date,
    closedDates: closedDays.closedDates,
  });

  return (
    <PaymentDetailClient
      payment={r.data}
      journalEntries={jes ?? []}
      voidBlockedByClose={voidBlockedByClose}
    />
  );
}
