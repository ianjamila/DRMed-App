import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { PageHeader } from "@/components/staff/page-header";
import { PettyCashDatePicker } from "./petty-cash-date-picker";
import { PettyCashForm } from "./petty-cash-form";
import { PettyCashList, type PettyCashRow } from "./petty-cash-list";

export const metadata = { title: "Petty cash" };
export const dynamic = "force-dynamic";

interface SearchParams {
  date?: string;
}

export default async function PettyCashPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const params = await searchParams;
  const today = todayManilaISODate();
  const business_date = isISODate(params.date) ? params.date : today;
  const isToday = business_date === today;
  const admin = createAdminClient();

  // Reception can't read journal_entries via RLS (admin-only), so read with the
  // service-role client here in the RSC. Only the viewed day's petty-cash
  // entries; the reversal JEs themselves (source_kind='reversal') are excluded
  // — a reversed original shows up here with status='reversed'.
  const { data: entries } = await admin
    .from("journal_entries")
    .select(
      "id, entry_number, description, status, created_at, journal_lines(debit_php, credit_php)",
    )
    .eq("source_kind", "petty_cash")
    .eq("posting_date", business_date)
    .order("created_at", { ascending: false });

  const rows: PettyCashRow[] = (entries ?? []).map((e) => {
    // A petty-cash JE is DR <expense> / CR 1010; the expense amount = the total
    // debits (the CR cash line has debit 0). Summing debits is robust even if a
    // future entry ever splits across multiple debit lines.
    const amount = (e.journal_lines ?? []).reduce(
      (sum, l) => sum + (Number(l.debit_php) || 0),
      0,
    );
    return {
      id: e.id,
      entry_number: e.entry_number,
      description: e.description,
      amount_php: amount,
      status: e.status as PettyCashRow["status"],
      created_at: e.created_at,
    };
  });

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Petty cash"
        subtitle="Log small cash expenses paid from the till — transport, courier, office or lab supplies, minor repairs. Each entry is recorded in the books so the day's cash count adds up. For anything paid by GCash, bank transfer, or a vendor invoice, ask admin."
      />

      <PettyCashDatePicker date={business_date} today={today} />

      <div className="max-w-3xl space-y-6">
        <PettyCashForm defaultDate={business_date} />

        <section className="space-y-3">
          <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
            {isToday ? "Today's petty cash" : "Petty cash for this day"}
          </h2>
          <PettyCashList rows={rows} isToday={isToday} />
        </section>
      </div>
    </div>
  );
}
