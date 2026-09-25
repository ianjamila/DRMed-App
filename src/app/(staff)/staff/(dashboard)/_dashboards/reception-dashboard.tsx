import { quickLinkGroupsFor } from "@/components/staff/staff-nav-config";
import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { manilaDate, manilaDateTime, manilaRangeUtc, todayManilaISODate } from "@/lib/dates/manila";
import { loadHiddenCardIds } from "@/lib/dashboards/card-prefs";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS, type PageFetcher } from "@/lib/reports/paging";
import { reportError } from "@/lib/observability/report-error";
import { RealtimeRefresher, type Subscription } from "@/components/staff/realtime-refresher";
import { DashboardHeader } from "./_components/dashboard-header";
import { EodReminderBanner } from "./_components/eod-reminder-banner";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { formatPeso, formatTime, relativeAge } from "./_components/format";

const RECEPTION_SUBSCRIPTIONS = [
  { table: "appointments", event: "INSERT" },
  { table: "appointments", event: "UPDATE" },
  { table: "visits", event: "INSERT" },
  { table: "visits", event: "UPDATE" },
  { table: "payments", event: "INSERT" },
] as const satisfies readonly Subscription[];

// Quicklinks mirror the sidebar groups (Messages & Bookings / Front Desk) and use the
// sidebar's exact labels (Title Case, sidebar cleanup 2026-09-15). There is no
// "start a visit" quicklink: the Reception Queue's + New visit button is the
// one doorway to /staff/visits/new, so the dashboard points at the queue
// instead of duplicating it. "New patient" and "Petty cash" have no sidebar
// item of their own any more (the form is the Patients page's + New patient
// button; petty cash is a Cash Drawer tab) — both stay here as shortcuts
// because reception reaches for them many times a day. Cash Drawer sits under
// Front Desk, where the sidebar keeps it (Billing was folded into Front Desk
// 2026-09-24).
//
// There is deliberately no Personal group: owner decision 5 (2026-09-15) took
// My Payslips and My Profile off the dashboards. Both stay reachable from the
// sidebar's Personal section, which is where staff look for them.
//
// Partner revision 8 made the sidebar's "Hidden Tabs" section admin-only, so
// reception no longer sees Sell gift code or Registration link there at all.
// Sell gift code is therefore surfaced here as reception's ONE deliberate
// doorway to the rare counter sale — without it they'd have to type the URL.
// Registration link stays parked (it only saves counter time; patients get
// the link from the website).
//
// The old "Personal" group (My payslips, My profile) was dropped 2026-09:
// both live in the sidebar's own Personal section for every role, so they
// don't earn dashboard space here too — the dashboard-review decision was to
// keep this screen to shortcuts reception can't already reach in one click
// from the sidebar.
//
// Quick quote stays: reception may now see test names and prices (2026-09-15
// dashboard-review decision), so the old objection to surfacing a price list
// here is gone.
//
// "Visit archive" (unfiltered, every date) is NOT a duplicate of the "Visits
// today" card above, which links into the same route pre-filtered to today —
// one is "browse all history", the other is "what happened today". Both earn
// their spot.
const QUICK_GROUPS = quickLinkGroupsFor("reception", "reception");

const SKIP_COUNT = Promise.resolve({ count: 0, data: null, error: null });
const SKIP_DATA = Promise.resolve({ data: null, error: null });

type CashDrawerState = {
  expected_cash_php?: number;
  opening_float_php?: number;
  closed?: { closed_at: string } | null;
};

type PatientEmbed =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

// The rows behind the "Arrivals & callbacks" strip: confirmed/arrived
// appointments (scheduled or untimed walk-ins) plus pending_callback rows,
// merged and grouped by booking so a multi-service booking is one row.
type ArrivalRow = {
  id: string;
  scheduled_at: string | null;
  status: string;
  walk_in_name: string | null;
  created_at: string;
  booking_group_id: string | null;
  patients: PatientEmbed;
};

// The "arrived, awaiting registration" set for the Walk-ins card — selected
// (not counted head-only) so distinct bookings can be grouped in JS.
type WalkInRow = {
  id: string;
  booking_group_id: string | null;
};

type VisitRow = {
  id: string;
  visit_number: string;
  total_php: number | null;
  paid_php: number | null;
  patients: PatientEmbed;
};

// Money-only projection for the "To collect from today's patients" total —
// paged with fetchAllRows (below) rather than a bare select, so a busy day
// can't silently exceed PostgREST's 1000-row cap the way the admin HMO card
// once did.
type UnpaidMoneyRow = {
  id: string;
  total_php: number | null;
  paid_php: number | null;
};

// The rows behind the "Website messages waiting" strip: the newest 'new'
// contact_messages rows. Only the columns rendered are selected.
type ContactMessageRow = {
  id: string;
  name: string;
  subject: string | null;
  created_at: string;
};

function pluckPatientName(p: PatientEmbed): string | null {
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

// One booking (or one standalone row) per group, first-seen order preserved —
// matches appointments/page.tsx's own groupRows: the "lead" row is whichever
// row of the group the query returned first.
function groupArrivals(rows: ArrivalRow[]): ArrivalRow[] {
  const seen = new Set<string>();
  const groups: ArrivalRow[] = [];
  for (const r of rows) {
    const key = r.booking_group_id ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(r);
  }
  return groups;
}

// fetchAllRows throws on a DB error (by design — a partial export that reads
// as complete is worse than a failed one). A dashboard card can't take the
// whole page down with it, so this wraps that in a per-widget error instead.
async function safeFetchAllRows<T>(
  fetchPage: PageFetcher<T>,
  maxRows: number,
): Promise<{ rows: T[]; truncated: boolean; error: unknown }> {
  try {
    const { rows, truncated } = await fetchAllRows<T>(fetchPage, maxRows);
    return { rows, truncated, error: null };
  } catch (error) {
    return { rows: [], truncated: false, error };
  }
}

// Today's Manila calendar date, plus its UTC instant bounds — shared by the
// query loader and the render function so "today" can't drift between them.
function todayManilaWindow(): { today: string; fromIso: string; toIso: string } {
  const today = todayManilaISODate();
  const { fromIso, toIso } = manilaRangeUtc(today, today);
  // today is always a well-formed YYYY-MM-DD (todayManilaISODate's own
  // format), so manilaRangeUtc can't return null bounds here.
  return { today, fromIso: fromIso as string, toIso: toIso as string };
}

async function loadReceptionStats(userId: string, show: (id: string) => boolean) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { today, fromIso: todayFromIso, toIso: todayToIso } = todayManilaWindow();

  // Cash drawer: pick the first active shift to read its state (and its
  // label, so the card can name which drawer's figure is being shown — a
  // dashboard left open across a shift change used to read as "the" drawer
  // with no way to tell which one). Matches the reception cash-drawer page's
  // selection logic.
  const activeShiftPromise = show("reception.cash_drawer")
    ? admin
        .from("cash_shifts")
        .select("id, label")
        .eq("is_active", true)
        .order("sort_order")
        .limit(1)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const { data: activeShift, error: activeShiftError } = await activeShiftPromise;

  const cashDrawerStatePromise =
    show("reception.cash_drawer") && activeShift
      ? admin.rpc("cash_drawer_state", {
          p_business_date: today,
          p_shift_id: activeShift.id,
        })
      : SKIP_DATA;

  const [
    visitsToday,
    unpaidRows,
    pendingRelease,
    walkInsRows,
    newMessagesCount,
    newCorporateMessagesCount,
    giftCodesToday,
    arrivalsRows,
    unpaidVisitsStrip,
    recentMessages,
    cashDrawerState,
    todayOrders,
  ] = await Promise.all([
    show("reception.visits_today")
      ? supabase
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("visit_date", today)
          .is("deleted_at", null)
      : SKIP_COUNT,
    show("reception.unpaid_balance")
      ? safeFetchAllRows<UnpaidMoneyRow>(
          (from, to) =>
            supabase
              .from("visits")
              .select("id, total_php, paid_php")
              .eq("visit_date", today)
              .in("payment_status", ["unpaid", "partial"])
              // HMO out-of-pocket is never reception's to collect — an HMO
              // visit can sit unpaid at the counter by design (the provider
              // settles later, tracked under Patient AR / HMO claims), so it
              // must not inflate a "money to collect at the counter" total.
              // Same predicate as the queue's "waiting" stage below, so this
              // card and its destination finally share one definition.
              .is("hmo_provider_id", null)
              .is("deleted_at", null)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<UnpaidMoneyRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : Promise.resolve({ rows: [] as UnpaidMoneyRow[], truncated: false, error: null }),
    show("reception.pending_release")
      ? supabase
          .from("test_requests")
          .select("id, services!inner ( id ), visits!inner ( id )", {
            count: "exact",
            head: true,
          })
          .eq("status", "ready_for_release")
          // A package header auto-promotes to ready_for_release before its
          // components have results (0040) — don't count the header as work
          // waiting when the actual lab lines beneath it aren't done yet.
          .eq("is_package_header", false)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          // "Results ready, awaiting release" is lab work. A consultation is
          // never awaiting release — reception completes it at the counter —
          // but undoing an already-completed one parks it at
          // `ready_for_release`, where it was counted here and sat in the
          // tile as work nobody owes. Same reasoning lab-tat.ts applies to
          // its own Pending tile.
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      : SKIP_COUNT,
    // Selected (not head-count) so distinct BOOKINGS can be grouped in JS —
    // a single multi-service booking is several `appointments` rows sharing
    // one booking_group_id, and a head-count would count each row.
    show("reception.walk_ins_waiting")
      ? supabase
          .from("appointments")
          .select("id, booking_group_id")
          .eq("status", "arrived")
          // Bound: the clinic never has more than a few dozen people
          // simultaneously arrived-and-unregistered — 500 is a generous
          // ceiling, not a real limit on a normal day.
          .limit(500)
          .returns<WalkInRow[]>()
      : SKIP_DATA,
    show("reception.new_messages")
      ? supabase
          .from("contact_messages")
          .select("id", { count: "exact", head: true })
          .eq("status", "new")
      : SKIP_COUNT,
    show("reception.new_messages")
      ? supabase
          .from("contact_messages")
          .select("id", { count: "exact", head: true })
          .eq("status", "new")
          .eq("kind", "corporate")
      : SKIP_COUNT,
    show("reception.gift_codes_sold")
      ? supabase
          .from("gift_codes")
          .select("id", { count: "exact", head: true })
          .eq("status", "purchased")
          .gte("purchased_at", todayFromIso)
          .lt("purchased_at", todayToIso)
      : SKIP_COUNT,
    show("reception.strip_appointments")
      ? supabase
          .from("appointments")
          .select(
            "id, scheduled_at, status, walk_in_name, created_at, booking_group_id, patients ( first_name, last_name )",
          )
          .in("status", ["confirmed", "arrived", "pending_callback"])
          // Untimed rows (scheduled_at null — a walk-in with no booked time,
          // and every pending_callback) carry over from previous days by
          // design: appointments/page.tsx's loadOpenWalkIns/loadPendingCallback
          // do exactly this, because a walk-in booked yesterday afternoon is
          // still standing at the counter this morning and must not vanish.
          // Only a SCHEDULED row is bounded to today, so a stale confirmed
          // slot from last week doesn't linger here forever.
          .or(
            `scheduled_at.is.null,and(scheduled_at.gte.${todayFromIso},scheduled_at.lt.${todayToIso})`,
          )
          .order("created_at", { ascending: true })
          // Bound: a generous ceiling before grouping+trimming to 5 — a day
          // never has hundreds of open arrivals and callbacks at once.
          .limit(200)
          .returns<ArrivalRow[]>()
      : SKIP_DATA,
    show("reception.strip_unpaid")
      ? supabase
          .from("visits")
          .select(
            "id, visit_number, total_php, paid_php, patients ( first_name, last_name )",
          )
          .eq("visit_date", today)
          .in("payment_status", ["unpaid", "partial"])
          .is("hmo_provider_id", null)
          .is("deleted_at", null)
          .order("created_at", { ascending: true }) // oldest waiting first
          .limit(5)
          .returns<VisitRow[]>()
      : SKIP_DATA,
    show("reception.strip_messages")
      ? supabase
          .from("contact_messages")
          .select("id, name, subject, created_at")
          .eq("status", "new")
          .order("created_at", { ascending: true }) // oldest waiting first
          .limit(5)
          .returns<ContactMessageRow[]>()
      : SKIP_DATA,
    cashDrawerStatePromise,
    // Today's leaf orders, joined to their service for kind/section bucketing.
    // Tied to the "Visits today" card's visibility so a hidden card costs no
    // query. Deliberately does NOT carry DOCTOR_KINDS_PG_LIST — this strip
    // shows every class on purpose and splits them in JS with bucketOf.
    show("reception.visits_today")
      ? supabase
          .from("test_requests")
          .select("id, services!inner ( kind, section ), visits!inner ( visit_date )")
          .eq("is_package_header", false)
          .eq("visits.visit_date", today)
          // A cancelled order was never actually done — counting it here
          // overstated today's real order volume.
          .neq("status", "cancelled")
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
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

  const unpaidCount = unpaidRows.rows.length;
  const unpaidTotalPhp = unpaidRows.rows.reduce(
    (s, v) => s + (Number(v.total_php ?? 0) - Number(v.paid_php ?? 0)),
    0,
  );

  const walkInRowsData = (walkInsRows.data ?? []) as WalkInRow[];
  const walkInsWaiting = new Set(
    walkInRowsData.map((r) => r.booking_group_id ?? r.id),
  ).size;

  const arrivals = groupArrivals((arrivalsRows.data ?? []) as ArrivalRow[]).slice(0, 5);

  const cashState = cashDrawerState.data as CashDrawerState | null;
  const expectedCash = cashState?.expected_cash_php ?? null;
  const isClosed = cashState?.closed != null;

  // These queries used to fail silently — `.count ?? 0` / `.data ?? []`
  // swallowed the error and the card rendered a reassuring zero or all-clear,
  // exactly the "unreadable AP total shows as ₱0.00" bug the shared StatCard/
  // ActivityStrip `error` prop exists to prevent. Surface every query error
  // the way lab-dashboard.tsx does, instead of discarding it.
  const namedResults: { scope: string; error: unknown }[] = [
    { scope: "visits_today", error: visitsToday.error },
    { scope: "unpaid_balance", error: unpaidRows.error },
    { scope: "pending_release", error: pendingRelease.error },
    { scope: "walk_ins_waiting", error: walkInsRows.error },
    { scope: "new_messages", error: newMessagesCount.error },
    { scope: "new_messages_corporate", error: newCorporateMessagesCount.error },
    { scope: "gift_codes_sold", error: giftCodesToday.error },
    { scope: "strip_appointments", error: arrivalsRows.error },
    { scope: "strip_unpaid", error: unpaidVisitsStrip.error },
    { scope: "strip_messages", error: recentMessages.error },
    { scope: "cash_drawer", error: activeShiftError ?? cashDrawerState.error },
    { scope: "orders_by_type", error: todayOrders.error },
  ];
  await Promise.all(
    namedResults
      .filter((r) => r.error)
      .map((r) =>
        reportError({
          scope: `reception-dashboard.${r.scope}`,
          error: r.error,
          metadata: { userId },
        }),
      ),
  );

  return {
    today,
    todayFromIso,
    todayToIso,

    visitsToday: visitsToday.count ?? 0,
    visitsTodayError: !!visitsToday.error,

    unpaidCount,
    unpaidTotalPhp,
    unpaidTruncated: unpaidRows.truncated,
    unpaidError: !!unpaidRows.error,

    pendingRelease: pendingRelease.count ?? 0,
    pendingReleaseError: !!pendingRelease.error,

    walkInsWaiting,
    walkInsError: !!walkInsRows.error,

    newMessages: newMessagesCount.count ?? 0,
    newMessagesError: !!newMessagesCount.error,

    newCorporateMessages: newCorporateMessagesCount.count ?? 0,
    newCorporateMessagesError: !!newCorporateMessagesCount.error,

    giftCodesToday: giftCodesToday.count ?? 0,
    giftCodesError: !!giftCodesToday.error,

    arrivals,
    arrivalsError: !!arrivalsRows.error,

    unpaidVisits: (unpaidVisitsStrip.data ?? []) as VisitRow[],
    unpaidVisitsError: !!unpaidVisitsStrip.error,

    recentMessages: (recentMessages.data ?? []) as ContactMessageRow[],
    recentMessagesError: !!recentMessages.error,

    cashDrawer: {
      expectedCash,
      isClosed,
      hasShift: !!activeShift,
      shiftLabel: activeShift?.label ?? null,
      error: !!(activeShiftError || cashDrawerState.error),
    },

    orderBreakdown,
    orderBreakdownError: !!todayOrders.error,
  };
}

export async function ReceptionDashboard({
  session,
}: {
  session: StaffSession;
}) {
  const hidden = await loadHiddenCardIds("reception");
  const show = (id: string) => !hidden.has(id);
  const stats = await loadReceptionStats(session.user_id, show);
  const { today, todayFromIso, todayToIso } = stats;

  function arrivalMeta(a: ArrivalRow): string {
    // Untimed rows (walk-ins with no booked time, and every callback) have no
    // scheduled instant to render — show how long they've been waiting
    // instead.
    if (a.status === "pending_callback" || !a.scheduled_at) {
      return relativeAge(a.created_at);
    }
    const isToday = a.scheduled_at >= todayFromIso && a.scheduled_at < todayToIso;
    return isToday
      ? formatTime(a.scheduled_at)
      : `${manilaDate(a.scheduled_at)}, ${formatTime(a.scheduled_at)}`;
  }

  const arrivalItems: ActivityItem[] = stats.arrivals.map((a) => {
    const name = pluckPatientName(a.patients) ?? a.walk_in_name ?? "Walk-in";
    const secondary =
      a.status === "pending_callback"
        ? "Callback"
        : a.status === "arrived"
          ? "Arrived"
          : "Confirmed";
    return {
      primary: name,
      secondary,
      meta: arrivalMeta(a),
      href: "/staff/appointments",
    };
  });

  const unpaidItems: ActivityItem[] = stats.unpaidVisits.map((v) => {
    const name = pluckPatientName(v.patients) ?? "Walk-in";
    const balance = Number(v.total_php ?? 0) - Number(v.paid_php ?? 0);
    return {
      primary: name,
      secondary: `Visit ${v.visit_number}`,
      meta: formatPeso(balance),
      href: `/staff/payments/new?visit_id=${v.id}`,
    };
  });

  const messageItems: ActivityItem[] = stats.recentMessages.map((m) => ({
    primary: m.name,
    secondary: m.subject ?? "No subject",
    meta: manilaDateTime(m.created_at),
    href: `/staff/messages/${m.id}`,
  }));

  const shiftLabel = stats.cashDrawer.shiftLabel;
  const cashHint = !stats.cashDrawer.hasShift
    ? "No active shift configured"
    : stats.cashDrawer.isClosed
      ? `${shiftLabel ?? "Shift"} closed for today`
      : `Expected cash on hand — ${shiftLabel ?? "current shift"}`;

  const cashValue =
    stats.cashDrawer.expectedCash !== null
      ? formatPeso(stats.cashDrawer.expectedCash)
      : "—";

  const unpaidHint = stats.unpaidTruncated
    ? `${formatPeso(stats.unpaidTotalPhp)}+ — capped at ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows, true total is higher`
    : `${stats.unpaidCount} visit${stats.unpaidCount === 1 ? "" : "s"} unpaid / partial`;

  const messagesStripTitle =
    show("reception.new_messages") && !stats.newMessagesError
      ? `Website messages waiting (${stats.newMessages})`
      : "Website messages waiting";

  const newMessagesHint =
    stats.newCorporateMessagesError
      ? "Waiting for a reply"
      : stats.newCorporateMessages > 0
        ? `Waiting for a reply · ${stats.newCorporateMessages} corporate`
        : "Waiting for a reply";

  // SectionHeading's own `if (!children)` check can't detect "every card in
  // this section is hidden" — its caller always passes a (truthy) <div>, even
  // an empty one. Compute per-section visibility here and skip the whole
  // section (heading included) rather than leaving a bare title over nothing.
  const hasSnapshot = [
    "reception.visits_today",
    "reception.unpaid_balance",
    "reception.pending_release",
    "reception.walk_ins_waiting",
    "reception.new_messages",
    "reception.gift_codes_sold",
    "reception.cash_drawer",
  ].some(show);
  const hasAttention = [
    "reception.strip_appointments",
    "reception.strip_unpaid",
    "reception.strip_messages",
  ].some(show);
  const hasQuicklinks = QUICK_GROUPS.length > 0;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        subscriptions={RECEPTION_SUBSCRIPTIONS}
        channelName="reception-dashboard"
      />
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel="Reception"
        title="Today at the front desk"
        updatedAt={new Date()}
      />

      <EodReminderBanner />

      {hasSnapshot && (
        <SectionHeading title="Today's snapshot">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {show("reception.visits_today") && (
              <StatCard
                label="Visits today"
                value={stats.visitsToday}
                hint="Visits opened today"
                href={`/staff/visits?start=${today}&end=${today}`}
                error={stats.visitsTodayError}
              />
            )}
            {show("reception.unpaid_balance") && (
              <StatCard
                label="To collect from today's patients"
                value={formatPeso(stats.unpaidTotalPhp)}
                hint={unpaidHint}
                href="/staff/visits/queue?stage=waiting"
                accent={stats.unpaidCount > 0 ? "warn" : "default"}
                error={stats.unpaidError}
              />
            )}
            {show("reception.pending_release") && (
              <StatCard
                label="Waiting to be released"
                value={stats.pendingRelease}
                hint="All dates — results ready, awaiting release"
                href="/staff/visits/queue?stage=processing"
                error={stats.pendingReleaseError}
              />
            )}
            {show("reception.walk_ins_waiting") && (
              <StatCard
                label="Arrivals awaiting registration"
                value={stats.walkInsWaiting}
                hint="Checked in, not yet registered — one per booking"
                href="/staff/appointments"
                error={stats.walkInsError}
              />
            )}
            {show("reception.new_messages") && (
              <StatCard
                label="Website messages"
                value={stats.newMessages}
                hint={newMessagesHint}
                href="/staff/messages"
                accent={stats.newMessages > 0 ? "warn" : "default"}
                error={stats.newMessagesError}
              />
            )}
            {show("reception.gift_codes_sold") && (
              <StatCard
                label="Gift codes sold"
                value={stats.giftCodesToday}
                hint="Sold today"
                href="/staff/gift-codes/sell"
                error={stats.giftCodesError}
              />
            )}
            {show("reception.cash_drawer") && (
              <StatCard
                label="Cash drawer"
                value={cashValue}
                hint={cashHint}
                href="/staff/payments/cash-drawer"
                error={stats.cashDrawer.error}
              />
            )}
          </div>
          {show("reception.visits_today") && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Today&apos;s orders by type (test lines)
              </p>
              {stats.orderBreakdownError ? (
                <p className="text-sm font-medium text-amber-700">
                  Couldn&apos;t load — this breakdown is unknown, not empty. Reload the page.
                </p>
              ) : (
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
              )}
            </div>
          )}
        </SectionHeading>
      )}

      {hasQuicklinks && (
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
      )}

      {hasAttention && (
        <SectionHeading title="What needs attention">
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Deliberately a WIDER set than the "Arrivals awaiting
                registration" card above, which counts checked-in arrivals
                only. This strip is the whole front-desk action list: today's
                bookings still to come, arrivals already waiting, and callbacks
                owed. The two are not meant to reconcile, so the titles say
                different things. */}
            {show("reception.strip_appointments") && (
              <ActivityStrip
                title="Today's bookings, arrivals & callbacks"
                items={arrivalItems}
                emptyMessage="Nothing booked or waiting."
                viewAllHref="/staff/appointments"
                error={stats.arrivalsError}
              />
            )}
            {show("reception.strip_unpaid") && (
              <ActivityStrip
                title="Patients waiting to pay"
                items={unpaidItems}
                emptyMessage="No payments waiting"
                viewAllHref="/staff/visits/queue?stage=waiting"
                error={stats.unpaidVisitsError}
              />
            )}
            {show("reception.strip_messages") && (
              <ActivityStrip
                title={messagesStripTitle}
                items={messageItems}
                emptyMessage="No website messages waiting."
                viewAllHref="/staff/messages"
                error={stats.recentMessagesError}
              />
            )}
          </div>
        </SectionHeading>
      )}
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
