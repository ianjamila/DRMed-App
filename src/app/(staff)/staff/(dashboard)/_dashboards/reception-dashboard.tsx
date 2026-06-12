import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { loadHiddenCardIds } from "@/lib/dashboards/card-prefs";
import { DashboardHeader } from "./_components/dashboard-header";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { formatPeso, formatTime, relativeAge } from "./_components/format";

// Quicklinks mirror the reorganized sidebar groups (Front desk / Billing /
// Services). Sell gift code, Cash drawer, and End of day were dropped per
// partner feedback — they now live under the sidebar's "Hidden tabs".
const QUICK_GROUPS: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: "Front desk",
    items: [
      { href: "/staff/patients/new", label: "New patient" },
      { href: "/staff/patients", label: "Patients" },
      { href: "/staff/appointments", label: "Appointments" },
      { href: "/staff/registration", label: "Registration link" },
      { href: "/staff/visits/queue", label: "Queue" },
      { href: "/staff/inquiries", label: "Inquiries" },
    ],
  },
  {
    label: "Billing",
    items: [
      { href: "/staff/visits", label: "Billing & receipts" },
      { href: "/staff/quote", label: "Quick quote" },
    ],
  },
  {
    label: "Services",
    items: [
      { href: "/staff/visits/new?filter=lab", label: "New lab request" },
      { href: "/staff/visits/new?filter=imaging", label: "New imaging request" },
    ],
  },
];

const SKIP_COUNT = Promise.resolve({ count: 0, data: null });
const SKIP_DATA = Promise.resolve({ data: null });

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

// Today's order breakdown (partner request #3): count test_request "orders" by
// category beneath the "Visits today" headline. Counts leaf rows only
// (is_package_header = false) so a package isn't double-counted with its
// components; the components themselves fall into Lab/Imaging by their section.
type OrderRow = {
  services:
    | { kind: string; section: string | null }
    | { kind: string; section: string | null }[]
    | null;
};

type OrderBreakdown = {
  lab: number;
  imaging: number;
  consults: number;
  procedures: number;
  other: number;
};

// Imaging has no distinct service kind — imaging services are kind=lab_test
// with an imaging_* section, so the Imaging bucket is section-driven.
const IMAGING_SECTIONS = new Set([
  "imaging_xray",
  "imaging_ultrasound",
  "imaging_ecg",
]);

function bucketOf(kind: string, section: string | null): keyof OrderBreakdown {
  if (section && IMAGING_SECTIONS.has(section)) return "imaging";
  if (kind === "doctor_consultation") return "consults";
  if (kind === "doctor_procedure") return "procedures";
  if (kind === "vaccine" || kind === "home_service") return "other";
  return "lab";
}

async function loadReceptionStats(show: (id: string) => boolean) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const today = todayManilaISODate();
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();

  // Cash drawer: pick the first active shift to read its state. This matches
  // the reception cash-drawer page's selection logic.
  const activeShiftPromise = show("reception.cash_drawer")
    ? admin
        .from("cash_shifts")
        .select("id")
        .eq("is_active", true)
        .order("sort_order")
        .limit(1)
        .maybeSingle()
    : Promise.resolve({ data: null });

  const { data: activeShift } = await activeShiftPromise;

  const cashDrawerStatePromise =
    show("reception.cash_drawer") && activeShift
      ? admin.rpc("cash_drawer_state", {
          p_business_date: today,
          p_shift_id: activeShift.id,
        })
      : SKIP_DATA;

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
    todayOrders,
  ] = await Promise.all([
    show("reception.visits_today")
      ? supabase
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("visit_date", today)
      : SKIP_COUNT,
    show("reception.unpaid_balance")
      ? supabase
          .from("visits")
          .select("total_php, paid_php")
          .eq("visit_date", today)
          .in("payment_status", ["unpaid", "partial"])
      : SKIP_DATA,
    show("reception.pending_release")
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "ready_for_release")
      : SKIP_COUNT,
    show("reception.walk_ins_waiting")
      ? supabase
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("status", "arrived")
      : SKIP_COUNT,
    show("reception.open_inquiries")
      ? supabase
          .from("inquiries")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending")
      : SKIP_COUNT,
    show("reception.gift_codes_sold")
      ? supabase
          .from("gift_codes")
          .select("id", { count: "exact", head: true })
          .eq("status", "purchased")
          .gte("purchased_at", startOfTodayUtc)
          .lt("purchased_at", startOfTomorrowUtc)
      : SKIP_COUNT,
    show("reception.strip_appointments")
      ? supabase
          .from("appointments")
          .select(
            "id, scheduled_at, status, walk_in_name, patients ( first_name, last_name )",
          )
          .in("status", ["confirmed", "arrived"])
          .gte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
          .limit(5)
          .returns<ApptRow[]>()
      : SKIP_DATA,
    show("reception.strip_unpaid")
      ? supabase
          .from("visits")
          .select(
            "id, visit_number, total_php, paid_php, patients ( first_name, last_name )",
          )
          .eq("visit_date", today)
          .in("payment_status", ["unpaid", "partial"])
          .order("created_at", { ascending: false })
          .limit(5)
          .returns<VisitRow[]>()
      : SKIP_DATA,
    show("reception.strip_inquiries")
      ? supabase
          .from("inquiries")
          .select("id, caller_name, channel, called_at")
          .eq("status", "pending")
          .order("called_at", { ascending: false })
          .limit(5)
          .returns<InquiryRow[]>()
      : SKIP_DATA,
    cashDrawerStatePromise,
    // Today's leaf orders, joined to their service for kind/section bucketing.
    // Tied to the "Visits today" card's visibility so a hidden card costs no query.
    show("reception.visits_today")
      ? supabase
          .from("test_requests")
          .select("id, services!inner ( kind, section ), visits!inner ( visit_date )")
          .eq("is_package_header", false)
          .eq("visits.visit_date", today)
          .returns<OrderRow[]>()
      : SKIP_DATA,
  ]);

  const orderBreakdown: OrderBreakdown = {
    lab: 0,
    imaging: 0,
    consults: 0,
    procedures: 0,
    other: 0,
  };
  for (const r of (todayOrders.data ?? []) as OrderRow[]) {
    const s = Array.isArray(r.services) ? r.services[0] : r.services;
    if (!s) continue;
    orderBreakdown[bucketOf(s.kind, s.section)] += 1;
  }

  const unpaidRows = (unpaidToday.data ?? []) as { total_php: number | null; paid_php: number | null }[];
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
    nextAppointments: (nextAppointments.data ?? []) as ApptRow[],
    unpaidVisits: (unpaidVisits.data ?? []) as VisitRow[],
    recentInquiries: (recentInquiries.data ?? []) as InquiryRow[],
    cashDrawer: { expectedCash, isClosed, hasShift: !!activeShift },
    orderBreakdown,
  };
}

export async function ReceptionDashboard({
  session,
}: {
  session: StaffSession;
}) {
  const hidden = await loadHiddenCardIds("reception");
  const show = (id: string) => !hidden.has(id);
  const stats = await loadReceptionStats(show);

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
    const name = pluckPatientName(v.patients) ?? "Walk-in";
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

      <SectionHeading title="Today's snapshot">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {show("reception.visits_today") && (
          <StatCard
            label="Visits today"
            value={stats.visitsToday}
            hint="Patients registered today"
            href="/staff/visits"
          />
        )}
        {show("reception.unpaid_balance") && (
          <StatCard
            label="Unpaid balance"
            value={formatPeso(stats.unpaidTotalPhp)}
            hint={`${stats.unpaidCount} visit${stats.unpaidCount === 1 ? "" : "s"} unpaid / partial`}
            href="/staff/visits"
            accent={stats.unpaidCount > 0 ? "warn" : "default"}
          />
        )}
        {show("reception.pending_release") && (
          <StatCard
            label="Pending release"
            value={stats.pendingRelease}
            hint="Results ready, awaiting payment"
            href="/staff/queue?filter=pending_release"
          />
        )}
        {show("reception.walk_ins_waiting") && (
          <StatCard
            label="Walk-ins waiting"
            value={stats.walkInsWaiting}
            hint="Arrived, awaiting registration"
            href="/staff/appointments"
          />
        )}
        {show("reception.open_inquiries") && (
          <StatCard
            label="Open inquiries"
            value={stats.openInquiries}
            hint="Pending follow-up"
            href="/staff/inquiries"
            accent={stats.openInquiries > 0 ? "warn" : "default"}
          />
        )}
        {show("reception.gift_codes_sold") && (
          <StatCard
            label="Gift codes sold"
            value={stats.giftCodesToday}
            hint="Sold today"
            href="/staff/gift-codes/sell"
          />
        )}
        {show("reception.cash_drawer") && (
          <StatCard
            label="Cash drawer"
            value={cashValue}
            hint={cashHint}
            href="/staff/payments/cash-drawer"
          />
        )}
        </div>
        {show("reception.visits_today") && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Today&apos;s orders by type
            </p>
            <div className="flex flex-wrap gap-2">
              <OrderChip label="Lab" value={stats.orderBreakdown.lab} />
              <OrderChip label="Imaging" value={stats.orderBreakdown.imaging} />
              <OrderChip label="Consults" value={stats.orderBreakdown.consults} />
              <OrderChip
                label="Procedures"
                value={stats.orderBreakdown.procedures}
              />
              {stats.orderBreakdown.other > 0 && (
                <OrderChip label="Other" value={stats.orderBreakdown.other} />
              )}
            </div>
          </div>
        )}
      </SectionHeading>

      <SectionHeading title="Quicklinks">
        <div className="grid gap-4">
          {QUICK_GROUPS.map((g) => (
            <div key={g.label}>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                {g.label}
              </p>
              <QuickLinks items={g.items} />
            </div>
          ))}
        </div>
      </SectionHeading>

      <SectionHeading title="What needs attention">
        <div className="grid gap-4 lg:grid-cols-3">
        {show("reception.strip_appointments") && (
          <ActivityStrip
            title="Next appointments"
            items={apptItems}
            emptyMessage="No upcoming appointments."
            viewAllHref="/staff/appointments"
          />
        )}
        {show("reception.strip_unpaid") && (
          <ActivityStrip
            title="Today's unpaid visits"
            items={unpaidItems}
            emptyMessage="All today's visits are paid."
            viewAllHref="/staff/visits"
          />
        )}
        {show("reception.strip_inquiries") && (
          <ActivityStrip
            title="Recent inquiries"
            items={inquiryItems}
            emptyMessage="No pending inquiries."
            viewAllHref="/staff/inquiries"
          />
        )}
        </div>
      </SectionHeading>
    </div>
  );
}

function OrderChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm">
      <span className="font-medium text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      <span className="font-heading font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </span>
    </div>
  );
}
