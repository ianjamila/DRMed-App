import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { redirect } from "next/navigation";
import { todayManilaISODate } from "@/lib/dates/manila";
import { EodClient } from "./eod-client";

export const metadata = { title: "End of day — staff" };
export const dynamic = "force-dynamic";

interface SearchParams { date?: string; shift?: string }

export default async function EodPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const params = await searchParams;
  const business_date = params.date ?? todayManilaISODate();
  const admin = createAdminClient();

  const { data: shifts } = await admin
    .from("cash_shifts").select("id, code, label").eq("is_active", true).order("sort_order");
  const shift_id = params.shift ?? shifts?.[0]?.id;
  if (!shift_id) return <main className="p-6"><p>No active cash shift configured.</p></main>;

  const { data: state } = await admin.rpc("cash_drawer_state", {
    p_business_date: business_date,
    p_shift_id: shift_id,
  });

  return (
    <EodClient
      isAdmin={session.role === "admin"}
      businessDate={business_date}
      shiftId={shift_id}
      state={(state as Record<string, unknown>) ?? {}}
    />
  );
}
