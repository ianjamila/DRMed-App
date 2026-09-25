import { fetchCompleteRows } from "@/lib/reports/paging";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { PaymentsTabs } from "../_components/payments-tabs";
import { PETTY_CASH_COA_TO_CATEGORY } from "@/lib/accounting/expense-mappings";
import { PettyCashDatePicker } from "./petty-cash-date-picker";
import { PettyCashForm } from "./petty-cash-form";
import { PettyCashList, type PettyCashRow } from "./petty-cash-list";

export const metadata = { title: ROUTE_NAME["/staff/payments/petty-cash"] };
export const dynamic = "force-dynamic";

interface SearchParams {
  date?: string;
  shift?: string;
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

  // Same active-shift list Cash Drawer reads, so the two tabs offer the same
  // choices and the round trip (drawer -> petty cash -> drawer) stays on one
  // shift.
  const { data: shifts } = await admin
    .from("cash_shifts")
    .select("id, code, label")
    .eq("is_active", true)
    .order("sort_order");

  // Unlike Cash Drawer's own `params.shift ?? shifts?.[0]?.id`, validate the
  // query param against the active list rather than trusting it outright — a
  // stale or tampered `?shift=` must fall back to the default, not silently
  // pass an inactive/unknown id through to the writer.
  const currentShift = (params.shift && shifts?.find((s) => s.id === params.shift)) ?? shifts?.[0];
  if (!currentShift) {
    return <main className="p-6"><p>No active cash shift configured. Ask admin.</p></main>;
  }
  const shift_id = currentShift.id;

  // Reception can't read these tables via RLS (admin-only), so read with the
  // service-role client here in the RSC.
  //
  // The list reads `eod_cash_adjustments`, not `journal_entries`. That is the
  // point of the unification: a till expense is one adjustment row whichever
  // door recorded it, so this page now shows petty cash logged here, petty cash
  // paid out from the Cash drawer's own modal, AND an admin Quick expense
  // booked to Clinic Cash. One physical till, one history.
  //
  // Filtered to the selected shift, same as Cash Drawer's own adjustments
  // list — with more than one active shift, an unfiltered list here would mix
  // in payouts that don't count against the drawer being viewed.
  const { data: entries, error: completeError } = await fetchCompleteRows((from, to) => admin
    .from("eod_cash_adjustments")
    .select(
      "id, amount_php, payee, notes, recorded_at, voided_at, contra_account_id, chart_of_accounts:contra_account_id(code, name)",
    )
    .eq("kind", "petty_cash")
    .eq("business_date", business_date)
    .eq("shift_id", shift_id)
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));
  if (completeError) throw new Error(completeError.message);

  const rows: PettyCashRow[] = (entries ?? []).map((e) => {
    // The category reception picked is stored as the contra account. Map it
    // back to the everyday phrase where we can; fall back to the account's own
    // name for anything outside the petty-cash subset (e.g. an admin Quick
    // expense booked to Rent).
    const coa = e.chart_of_accounts;
    const label =
      (coa ? PETTY_CASH_COA_TO_CATEGORY[coa.code] : undefined) ??
      coa?.name ??
      "Not categorised";

    // The Cash drawer's payout modal lets the expense-account picker be left
    // blank, which sends contra_account_id = NULL. The bridge then routes the
    // JE to 9999 Suspense (resolve_cash_adjustment_account) but never writes
    // 9999 back onto the adjustment row — so without this flag a
    // Suspense-parked payout would look identical to a properly categorised
    // one on the very page whose job is "one till, one history". Admin has to
    // reclassify these out of Suspense, so say so.
    const uncategorised = e.contra_account_id === null;

    return {
      id: e.id,
      label,
      uncategorised,
      payee: e.payee,
      note: e.notes,
      amount_php: Number(e.amount_php) || 0,
      voided: e.voided_at !== null,
      recorded_at: e.recorded_at,
    };
  });

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PaymentsTabs />
      <PageHeader
        eyebrow={SECTION_NAME["/staff/payments/cash-drawer"]}
        title={ROUTE_NAME["/staff/payments/petty-cash"]}
        subtitle="Log small cash expenses paid from the till — transport, courier, office or lab supplies, minor repairs. Each entry comes straight out of the drawer, so the day's expected cash drops by the same amount and the count still ties. For anything paid by GCash, bank transfer, or a vendor invoice, ask admin."
      />

      <PettyCashDatePicker
        date={business_date}
        today={today}
        shifts={shifts ?? []}
        currentShiftId={shift_id}
      />

      <div className="max-w-3xl space-y-6">
        {/* The form always records against the day being viewed, but never a
            future one — a payout can't leave the till before the day happens.
            Recording into an already-closed day is refused by the DB (P0015)
            with a message telling reception to ask admin to reopen. */}
        <PettyCashForm defaultDate={business_date} maxDate={today} shiftId={shift_id} />

        <section className="space-y-3">
          <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
            {isToday ? "Today's petty cash" : "Petty cash for this day"}
          </h2>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Includes cash paid out from the {ROUTE_NAME["/staff/payments/cash-drawer"]} tab
            {(shifts?.length ?? 0) > 1 ? ` for the ${currentShift.label} shift` : ""}, so this
            matches what the drawer expects.
          </p>
          <PettyCashList rows={rows} isToday={isToday} />
        </section>
      </div>
    </div>
  );
}
