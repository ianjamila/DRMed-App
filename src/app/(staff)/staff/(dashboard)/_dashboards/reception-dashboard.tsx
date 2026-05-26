import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { DashboardHeader } from "./_components/dashboard-header";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { formatPeso, formatTime, relativeAge } from "./_components/format";

const QUICK_LINKS = [
  { href: "/staff/patients", label: "Patients" },
  { href: "/staff/visits/new", label: "New visit" },
  { href: "/staff/visits", label: "Visit archive" },
  { href: "/staff/appointments", label: "Appointments" },
  { href: "/staff/quote", label: "Quick quote" },
  { href: "/staff/gift-codes/sell", label: "Sell gift code" },
  { href: "/staff/payments/cash-drawer", label: "Cash drawer" },
  { href: "/staff/payments/eod", label: "End of day" },
];

type CashDrawerState = {
  expected_cash_php?: number;
  opening_float_php?: number;
  closed?: { closed_at: string } | null;
};

type ApptRow = {
  id: string;
  scheduled_at: string | null;
  status: string;
  walk_in_name: string | null;
  patients: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

type VisitRow = {
  id: string;
  visit_number: string;
  total_php: number | null;
  paid_php: number | null;
  patients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type InquiryRow = {
  id: string;
  caller_name: string;
  channel: string;
  called_at: string;
};

function pluckPatientName(
  p:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null,
): string | null {
  if (!p) return null;
  const row = Array.isArray(p) ? p[0] : p;
  if (!row) return null;
  return `${row.first_name} ${row.last_name}`.trim();
}

async function loadReceptionStats() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const today = todayManilaISODate();
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();

  // Cash drawer: pick the first active shift to read its state. This matches
  // the reception cash-drawer page's selection logic.
  const { data: activeShift } = await admin
    .from("cash_shifts")
    .select("id")
    .eq("is_active", true)
    .order("sort_order")
    .limit(1)
    .maybeSingle();

  const cashDrawerStatePromise = activeShift
    ? admin.rpc("cash_drawer_state", {
        p_business_date: today,
        p_shift_id: activeShift.id,
      })
    : Promise.resolve({ data: null });

  const [
    visitsToday,
    unpaidToday,
    pendingRelease,
    walkInsWaiting,
    openInquiries,
    giftCodesToday,
    nextAppointments,
    unpaidVisits,
    recentInquiries,
    cashDrawerState,
  ] = await Promise.all([
    supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("visit_date", today),
    supabase
      .from("visits")
      .select("total_php, paid_php")
      .eq("visit_date", today)
      .in("payment_status", ["unpaid", "partial"]),
    supabase
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "ready_for_release"),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .is("scheduled_at", null)
      .eq("status", "confirmed")
      .gte("created_at", startOfTodayUtc)
      .lt("created_at", startOfTomorrowUtc),
    supabase
      .from("inquiries")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("gift_codes")
      .select("id", { count: "exact", head: true })
      .eq("status", "purchased")
      .gte("purchased_at", startOfTodayUtc)
      .lt("purchased_at", startOfTomorrowUtc),
    supabase
      .from("appointments")
      .select(
        "id, scheduled_at, status, walk_in_name, patients ( first_name, last_name )",
      )
      .in("status", ["confirmed", "arrived"])
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(5)
      .returns<ApptRow[]>(),
    supabase
      .from("visits")
      .select(
        "id, visit_number, total_php, paid_php, patients!inner ( first_name, last_name )",
      )
      .eq("visit_date", today)
      .in("payment_status", ["unpaid", "partial"])
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<VisitRow[]>(),
    supabase
      .from("inquiries")
      .select("id, caller_name, channel, called_at")
      .eq("status", "pending")
      .order("called_at", { ascending: false })
      .limit(5)
      .returns<InquiryRow[]>(),
    cashDrawerStatePromise,
  ]);

  const unpaidRows = unpaidToday.data ?? [];
  const unpaidCount = unpaidRows.length;
  const unpaidTotalPhp = unpaidRows.reduce(
    (s, v) => s + (Number(v.total_php ?? 0) - Number(v.paid_php ?? 0)),
    0,
  );

  const cashState = cashDrawerState.data as CashDrawerState | null;
  const expectedCash = cashState?.expected_cash_php ?? null;
  const isClosed = cashState?.closed != null;

  return {
    visitsToday: visitsToday.count ?? 0,
    unpaidCount,
    unpaidTotalPhp,
    pendingRelease: pendingRelease.count ?? 0,
    walkInsWaiting: walkInsWaiting.count ?? 0,
    openInquiries: openInquiries.count ?? 0,
    giftCodesToday: giftCodesToday.count ?? 0,
    nextAppointments: nextAppointments.data ?? [],
    unpaidVisits: unpaidVisits.data ?? [],
    recentInquiries: recentInquiries.data ?? [],
    cashDrawer: { expectedCash, isClosed, hasShift: !!activeShift },
  };
}

export async function ReceptionDashboard({
  session,
}: {
  session: StaffSession;
}) {
  const stats = await loadReceptionStats();

  const apptItems: ActivityItem[] = stats.nextAppointments.map((a) => {
    const name = pluckPatientName(a.patients) ?? a.walk_in_name ?? "Walk-in";
    return {
      primary: name,
      secondary: a.status === "arrived" ? "Arrived" : "Confirmed",
      meta: formatTime(a.scheduled_at),
      href: "/staff/appointments",
    };
  });

  const unpaidItems: ActivityItem[] = stats.unpaidVisits.map((v) => {
    const name = pluckPatientName(v.patients) ?? "—";
    const balance =
      Number(v.total_php ?? 0) - Number(v.paid_php ?? 0);
    return {
      primary: name,
      secondary: `Visit ${v.visit_number}`,
      meta: formatPeso(balance),
      href: `/staff/visits/${v.id}`,
    };
  });

  const inquiryItems: ActivityItem[] = stats.recentInquiries.map((i) => ({
    primary: i.caller_name,
    secondary: i.channel,
    meta: relativeAge(i.called_at),
    href: "/staff/inquiries",
  }));

  const cashHint = !stats.cashDrawer.hasShift
    ? "No active shift configured"
    : stats.cashDrawer.isClosed
      ? "Shift closed for today"
      : "Expected cash on hand";

  const cashValue =
    stats.cashDrawer.expectedCash !== null
      ? formatPeso(stats.cashDrawer.expectedCash)
      : "—";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel="Reception"
        title="Today at the front desk"
      />

      <SectionHeading title="Today's snapshot" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Visits today"
          value={stats.visitsToday}
          hint="Patients registered today"
          href="/staff/visits"
        />
        <StatCard
          label="Unpaid balance"
          value={formatPeso(stats.unpaidTotalPhp)}
          hint={`${stats.unpaidCount} visit${stats.unpaidCount === 1 ? "" : "s"} unpaid / partial`}
          href="/staff/visits"
          accent={stats.unpaidCount > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Pending release"
          value={stats.pendingRelease}
          hint="Results ready, awaiting payment"
          href="/staff/queue?filter=pending_release"
        />
        <StatCard
          label="Walk-ins waiting"
          value={stats.walkInsWaiting}
          hint="Confirmed without scheduled time"
          href="/staff/appointments"
        />
        <StatCard
          label="Open inquiries"
          value={stats.openInquiries}
          hint="Pending follow-up"
          href="/staff/inquiries"
          accent={stats.openInquiries > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Gift codes sold"
          value={stats.giftCodesToday}
          hint="Sold today"
          href="/staff/gift-codes/sell"
        />
        <StatCard
          label="Cash drawer"
          value={cashValue}
          hint={cashHint}
          href="/staff/payments/cash-drawer"
        />
      </div>

      <SectionHeading title="Quicklinks" />
      <QuickLinks items={QUICK_LINKS} />

      <SectionHeading title="What needs attention" />
      <div className="grid gap-4 lg:grid-cols-3">
        <ActivityStrip
          title="Next appointments"
          items={apptItems}
          emptyMessage="No upcoming appointments."
          viewAllHref="/staff/appointments"
        />
        <ActivityStrip
          title="Today's unpaid visits"
          items={unpaidItems}
          emptyMessage="All today's visits are paid."
          viewAllHref="/staff/visits"
        />
        <ActivityStrip
          title="Recent inquiries"
          items={inquiryItems}
          emptyMessage="No pending inquiries."
          viewAllHref="/staff/inquiries"
        />
      </div>
    </div>
  );
}
