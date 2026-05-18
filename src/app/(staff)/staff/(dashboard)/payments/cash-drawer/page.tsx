import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { redirect } from "next/navigation";
import { todayManilaISODate } from "@/lib/dates/manila";
import { CashDrawerClient } from "./cash-drawer-client";

export const metadata = { title: "Cash drawer — staff" };
export const dynamic = "force-dynamic";

interface SearchParams { date?: string; shift?: string }

export default async function CashDrawerPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const params = await searchParams;
  const business_date = params.date ?? todayManilaISODate();
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
  const { data: rows } = await admin
    .from("eod_cash_adjustments")
    .select("*")
    .eq("business_date", business_date)
    .eq("shift_id", shift_id)
    .order("recorded_at", { ascending: false });

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code");

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .order("full_name");

  return (
    <CashDrawerClient
      sessionUserId={session.user_id}
      businessDate={business_date}
      shifts={shifts ?? []}
      currentShiftId={shift_id}
      state={(state as Record<string, unknown>) ?? {}}
      rows={rows ?? []}
      accounts={accounts ?? []}
      staff={staff ?? []}
    />
  );
}
