import { fetchCompleteRows } from "@/lib/reports/paging";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { redirect } from "next/navigation";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { loadPartnerLabs } from "@/lib/accounting/partner-labs.server";
import { CashDrawerClient } from "./cash-drawer-client";

export const metadata = { title: ROUTE_NAME["/staff/payments/cash-drawer"] };
export const dynamic = "force-dynamic";

interface SearchParams { date?: string; shift?: string }

export default async function CashDrawerPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const params = await searchParams;
  const today = todayManilaISODate();
  const business_date = isISODate(params.date) ? params.date : today;
  const admin = createAdminClient();

  const { data: shifts } = await admin
    .from("cash_shifts")
    .select("id, code, label")
    .eq("is_active", true)
    .order("sort_order");
  const shift_id = params.shift ?? shifts?.[0]?.id;
  if (!shift_id) {
    return <main className="p-6"><p>No active cash shift configured. Ask admin.</p></main>;
  }

  const { data: state } = await admin.rpc("cash_drawer_state", {
    p_business_date: business_date,
    p_shift_id: shift_id,
  });
  const { data: rows, error: completeError } = await fetchCompleteRows((from, to) => admin
    .from("eod_cash_adjustments")
    .select("*")
    .eq("business_date", business_date)
    .eq("shift_id", shift_id)
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));
  if (completeError) throw new Error(completeError.message);

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code");

  // Money Routing: whether reception picks the account for each kind, and the
  // account the picker starts on.
  const { data: routing } = await admin
    .from("cash_adjustment_account_map")
    .select("kind, account_id, requires_user_choice");

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .order("full_name");

  // 0164: reception can read active partner labs directly (vendors' read
  // policy allows it), so use the RLS-scoped server client here.
  const supabase = await createClient();
  const partnerLabs = await loadPartnerLabs(supabase);

  return (
    <CashDrawerClient
      sessionUserId={session.user_id}
      isAdmin={session.role === "admin"}
      businessDate={business_date}
      today={today}
      shifts={shifts ?? []}
      currentShiftId={shift_id}
      state={(state as Record<string, unknown>) ?? {}}
      rows={rows ?? []}
      accounts={accounts ?? []}
      routing={routing ?? []}
      staff={staff ?? []}
      partnerLabs={partnerLabs}
    />
  );
}
