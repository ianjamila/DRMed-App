import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { redirect } from "next/navigation";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { EodClient } from "./eod-client";

export const metadata = { title: "End of Day" };
export const dynamic = "force-dynamic";

interface SearchParams { date?: string; shift?: string }

export default async function EodPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const params = await searchParams;
  // Operations › Cash & cards now deep-links here per day, so `date` arrives
  // from another page's data rather than only from this page's own controls.
  // Fall back to today on anything that isn't a calendar date instead of
  // handing it to the RPC — a hand-edited URL should land on today, not on a
  // Postgres error page. Matches how the financial statements validate theirs.
  const business_date = isISODate(params.date) ? params.date : todayManilaISODate();
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
