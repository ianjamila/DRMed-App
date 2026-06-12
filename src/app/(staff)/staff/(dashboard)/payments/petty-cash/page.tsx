import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { PettyCashForm } from "./petty-cash-form";
import { PettyCashList, type PettyCashRow } from "./petty-cash-list";

export const metadata = { title: "Petty cash — staff" };
export const dynamic = "force-dynamic";

export default async function PettyCashPage() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const today = todayManilaISODate();
  const admin = createAdminClient();

  // Reception can't read journal_entries via RLS (admin-only), so read with the
  // service-role client here in the RSC. Only today's petty-cash entries; the
  // reversal JEs themselves (source_kind='reversal') are excluded — a reversed
  // original shows up here with status='reversed'.
  const { data: entries } = await admin
    .from("journal_entries")
    .select(
      "id, entry_number, description, status, created_at, journal_lines(debit_php, credit_php)",
    )
    .eq("source_kind", "petty_cash")
    .eq("posting_date", today)
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
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Billing
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Petty cash
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Log small cash expenses paid from the till — transport, courier,
          office or lab supplies, minor repairs. Each entry is recorded in the
          books so the day&apos;s cash count adds up. For anything paid by GCash,
          bank transfer, or a vendor invoice, ask admin.
        </p>
      </header>

      <PettyCashForm defaultDate={today} />

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Today&apos;s petty cash
        </h2>
        <PettyCashList rows={rows} />
      </section>
    </div>
  );
}
