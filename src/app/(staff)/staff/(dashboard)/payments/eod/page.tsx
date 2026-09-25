import { ROUTE_NAME } from "@/lib/staff/route-names";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { redirect } from "next/navigation";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { loadUnclosedEodDays } from "@/lib/accounting/eod-reminders";
import { EodClient } from "./eod-client";

export const metadata = { title: ROUTE_NAME["/staff/payments/eod"] };
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
  const today = todayManilaISODate();
  const business_date = isISODate(params.date) ? params.date : today;
  const admin = createAdminClient();

  const { data: shifts } = await admin
    .from("cash_shifts").select("id, code, label").eq("is_active", true).order("sort_order");
  // A stale or hand-edited `?shift=` falls back to the first active shift
  // instead of reading an inactive/unknown drawer (Cash Drawer does the same).
  const shift_id =
    (params.shift && shifts?.find((s) => s.id === params.shift)?.id) ??
    shifts?.[0]?.id;
  if (!shift_id) return <main className="p-6"><p>No active cash shift configured.</p></main>;

  const { data: state } = await admin.rpc("cash_drawer_state", {
    p_business_date: business_date,
    p_shift_id: shift_id,
  });

  // Earlier days nobody closed — empty until Admin sets a reminders start
  // date. The day on screen is left out: its own count is right below.
  const unclosedDays = (await loadUnclosedEodDays(admin, shift_id)).filter(
    (d) => d !== business_date,
  );

  return (
    <EodClient
      // Keyed on the day + shift so a half-typed count never carries over when
      // the picker switches to another day — it would close the wrong day.
      key={`${business_date}:${shift_id}`}
      isAdmin={session.role === "admin"}
      businessDate={business_date}
      today={today}
      shiftId={shift_id}
      shifts={shifts ?? []}
      unclosedDays={unclosedDays}
      state={(state as Record<string, unknown>) ?? {}}
    />
  );
}
