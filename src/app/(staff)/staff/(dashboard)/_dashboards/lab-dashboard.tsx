import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { sectionsForRole, type ServiceSection } from "@/lib/auth/role-sections";
import { todayManilaISODate } from "@/lib/dates/manila";
import { loadHiddenCardIds } from "@/lib/dashboards/card-prefs";
import { LAB_QUEUE_GATE_VISITS_OR } from "@/lib/visits/lab-gate";
import { reportError } from "@/lib/observability/report-error";
import { DashboardHeader } from "./_components/dashboard-header";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks, type QuickLink } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { PlannedCard } from "./_components/planned-card";
import { relativeAge } from "./_components/format";

type Role = StaffSession["role"];

const ROLE_TITLE: Record<Role, string> = {
  medtech: "Lab bench",
  xray_technician: "Imaging bench",
  pathologist: "Sign-off & review",
  admin: "Lab overview",
  reception: "Lab overview",
};

const ROLE_LABEL: Record<Role, string> = {
  medtech: "Medtech",
  xray_technician: "Imaging",
  pathologist: "Pathologist",
  admin: "Admin",
  reception: "Reception",
};

const SKIP_COUNT = Promise.resolve({ count: 0, data: null, error: null });
const SKIP_DATA = Promise.resolve({ data: null, error: null });

function buildQuickLinks(role: Role): QuickLink[] {
  const links: QuickLink[] = [
    { href: "/staff/queue", label: "Queue" },
  ];
  if (role === "pathologist" || role === "admin") {
    links.push({ href: "/staff/signoff", label: "Sign-off" });
  }
  if (role === "medtech" || role === "admin") {
    links.push({ href: "/staff/quote", label: "Quick quote" });
  }
  if (role === "admin") {
    links.push({ href: "/staff/admin/result-templates", label: "Result templates" });
  }
  // Every role draws a payslip, and they're checked on payday — worth a
  // shortcut off the bench. Lives in the sidebar's Personal section since
  // partner revision 8 moved it out of the now-admin-only "Hidden tabs".
  links.push({ href: "/staff/payslips", label: "My payslips" });
  return links;
}

// test_requests has NO foreign key to patients — only via visits. Embedding
// `patients ( … )` directly on test_requests errors at query time (silently,
// if nothing checks `.error`), so every patient name here is reached through
// `visits ( patients ( … ) )` instead.
type PatientEmbed =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

type QueueRow = {
  id: string;
  status: string;
  requested_at: string;
  visits: { id: string; patients: PatientEmbed } | { id: string; patients: PatientEmbed }[] | null;
  services: { name: string; section: string | null } | { name: string; section: string | null }[] | null;
};

type SignoffRow = {
  id: string;
  visits: { id: string; patients: PatientEmbed } | { id: string; patients: PatientEmbed }[] | null;
  services: { name: string } | { name: string }[] | null;
};

type CriticalRow = {
  id: string;
  direction: string;
  created_at: string;
  test_request_id: string;
  parameter_name: string;
};

function pluckName<T extends { first_name: string; last_name: string }>(
  v: T | T[] | null,
): string {
  if (!v) return "—";
  const row = Array.isArray(v) ? v[0] : v;
  if (!row) return "—";
  return `${row.first_name} ${row.last_name}`.trim();
}

/** Patient name reached through the visits embed — test_requests has no FK to patients. */
function pluckPatientName(
  v: { patients: PatientEmbed } | { patients: PatientEmbed }[] | null,
): string {
  if (!v) return "—";
  const visit = Array.isArray(v) ? v[0] : v;
  if (!visit) return "—";
  return pluckName(visit.patients);
}

function pluckService<T extends { name: string }>(v: T | T[] | null): string {
  if (!v) return "—";
  const row = Array.isArray(v) ? v[0] : v;
  return row?.name ?? "—";
}

async function loadLabStats(
  role: Role,
  userId: string,
  show: (id: string) => boolean,
) {
  const supabase = await createClient();
  const today = todayManilaISODate();
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();
  const sections = sectionsForRole(role);
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sectionList = (sections ?? []) as ServiceSection[];

  // Mirrors /staff/queue's worklist gate ("all"/"mine" tabs): a visit whose
  // money isn't settled (fully paid, waived, or HMO-billed) isn't claimable,
  // so it must not inflate this count either — the queue page would show
  // "empty" while this card claimed otherwise.
  const myUnclaimedPromise =
    show("lab.my_unclaimed") && (role === "medtech" || role === "xray_technician")
      ? supabase
          .from("test_requests")
          .select("id, services!inner(section), visits!inner(id)", { count: "exact", head: true })
          .in("status", ["requested", "in_progress"])
          .is("assigned_to", null)
          .in("services.section", sectionList)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
      : SKIP_COUNT;

  const myClaimedPromise =
    show("lab.my_claimed") && (role === "medtech" || role === "xray_technician")
      ? supabase
          .from("test_requests")
          .select("id, visits!inner(id)", { count: "exact", head: true })
          .eq("assigned_to", userId)
          .in("status", ["requested", "in_progress"])
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
      : SKIP_COUNT;

  // "Ready for sign-off" surfaces results the pathologist hasn't looked at
  // yet — status = result_uploaded, i.e. a result was linked but hasn't
  // reached ready_for_release. /staff/signoff is a real route but a
  // data-less placeholder (UI queued for a later phase), so the card links
  // to the working /staff/results list instead; see the "Coming soon"
  // PlannedCard below for the not-yet-built screen itself.
  const readyForSignoffPromise =
    show("lab.ready_for_signoff") && role === "pathologist"
      ? supabase
          .from("test_requests")
          .select("id, visits!inner(id)", { count: "exact", head: true })
          .eq("status", "result_uploaded")
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
      : SKIP_COUNT;

  const criticalAlertsPromise =
    show("lab.critical_alerts") && role === "pathologist"
      ? supabase
          .from("critical_alerts")
          .select("id", { count: "exact", head: true })
          .is("acknowledged_at", null)
      : SKIP_COUNT;

  // Same money-settled gate as myUnclaimedPromise above — a send-out that
  // hasn't cleared payment isn't in the bench's worklist either.
  const sendOutAwaitingPromise =
    show("lab.send_out_awaiting") && role === "medtech"
      ? supabase
          .from("test_requests")
          .select("id, services!inner(is_send_out), visits!inner(id)", { count: "exact", head: true })
          .in("status", ["requested", "in_progress"])
          .eq("services.is_send_out", true)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
      : SKIP_COUNT;

  const releasedTodayPromise =
    show("lab.released_today")
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "released")
          .eq("assigned_to", userId)
          .gte("released_at", startOfTodayUtc)
          .lt("released_at", startOfTomorrowUtc)
      : SKIP_COUNT;

  // test_requests has no FK to patients — the name has to come through
  // visits (as the count above already joins for the payment gate), never
  // embedded directly, or PostgREST errors the whole query.
  const oldestUnclaimedPromise =
    show("lab.strip_oldest_unclaimed") &&
    (role === "medtech" || role === "xray_technician")
      ? supabase
          .from("test_requests")
          .select(
            "id, status, requested_at, visits!inner ( id, patients ( first_name, last_name ) ), services!inner ( name, section )",
          )
          .in("status", ["requested", "in_progress"])
          .is("assigned_to", null)
          .in("services.section", sectionList)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
          .order("requested_at", { ascending: true })
          .limit(5)
          .returns<QueueRow[]>()
      : SKIP_DATA;

  const recentCriticalsPromise =
    show("lab.strip_recent_criticals") &&
    (role === "medtech" || role === "pathologist")
      ? supabase
          .from("critical_alerts")
          .select("id, direction, created_at, test_request_id, parameter_name")
          .gte("created_at", dayAgoIso)
          .order("created_at", { ascending: false })
          .limit(5)
          .returns<CriticalRow[]>()
      : SKIP_DATA;

  // Same status as the "Ready for sign-off" card above, deliberately: a
  // result that is linked but not yet signed off sits at result_uploaded,
  // and only reaches ready_for_release once sign-off happens (or when the
  // service needs none). This strip used to list ready_for_release, so a
  // strip titled "Pending sign-off" was showing work already past it — and
  // disagreeing with the card beside it.
  // Same fix as the strip above — patients only reaches this row through
  // visits, never embedded directly on test_requests.
  const pendingSignoffPromise =
    show("lab.strip_pending_signoff") && role === "pathologist"
      ? supabase
          .from("test_requests")
          .select(
            "id, services ( name ), visits!inner ( id, patients ( first_name, last_name ) )",
          )
          .eq("status", "result_uploaded")
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .order("requested_at", { ascending: true })
          .limit(5)
          .returns<SignoffRow[]>()
      : SKIP_DATA;

  const [
    myUnclaimed,
    myClaimed,
    readyForSignoff,
    criticalAlerts,
    sendOutAwaiting,
    releasedToday,
    oldestUnclaimed,
    recentCriticals,
    pendingSignoff,
  ] = await Promise.all([
    myUnclaimedPromise,
    myClaimedPromise,
    readyForSignoffPromise,
    criticalAlertsPromise,
    sendOutAwaitingPromise,
    releasedTodayPromise,
    oldestUnclaimedPromise,
    recentCriticalsPromise,
    pendingSignoffPromise,
  ]);

  // These queries used to fail silently — `.data ?? []` swallowed the error
  // and the strip just rendered its empty state, which is exactly how the
  // broken `patients ( … )` embed (no FK from test_requests) went unnoticed
  // in production. Surface every query error the way the rest of the app
  // does, instead of discarding it.
  const namedResults: { scope: string; error: unknown }[] = [
    { scope: "my_unclaimed", error: myUnclaimed.error },
    { scope: "my_claimed", error: myClaimed.error },
    { scope: "ready_for_signoff", error: readyForSignoff.error },
    { scope: "critical_alerts", error: criticalAlerts.error },
    { scope: "send_out_awaiting", error: sendOutAwaiting.error },
    { scope: "released_today", error: releasedToday.error },
    { scope: "oldest_unclaimed", error: oldestUnclaimed.error },
    { scope: "recent_criticals", error: recentCriticals.error },
    { scope: "pending_signoff", error: pendingSignoff.error },
  ];
  await Promise.all(
    namedResults
      .filter((r) => r.error)
      .map((r) =>
        reportError({
          scope: `lab-dashboard.${r.scope}`,
          error: r.error,
          metadata: { role, userId },
        }),
      ),
  );

  return {
    myUnclaimed: myUnclaimed.count ?? 0,
    myClaimed: myClaimed.count ?? 0,
    readyForSignoff: readyForSignoff.count ?? 0,
    criticalAlerts: criticalAlerts.count ?? 0,
    sendOutAwaiting: sendOutAwaiting.count ?? 0,
    releasedToday: releasedToday.count ?? 0,
    oldestUnclaimed: (oldestUnclaimed.data ?? []) as QueueRow[],
    recentCriticals: (recentCriticals.data ?? []) as CriticalRow[],
    pendingSignoff: (pendingSignoff.data ?? []) as SignoffRow[],
  };
}

export async function LabDashboard({ session }: { session: StaffSession }) {
  const role = session.role;
  const hidden = await loadHiddenCardIds(role);
  const show = (id: string) => !hidden.has(id);
  const stats = await loadLabStats(role, session.user_id, show);

  const oldestItems: ActivityItem[] = stats.oldestUnclaimed.map((r) => ({
    primary: pluckService(r.services),
    secondary: pluckPatientName(r.visits),
    meta: relativeAge(r.requested_at),
    href: "/staff/queue",
  }));

  // Critical alerts have their own worklist with the Acknowledge action —
  // send every entry point there instead of the general queue, which has
  // no critical-alert affordance at all.
  const criticalItems: ActivityItem[] = stats.recentCriticals.map((c) => ({
    primary: `${c.parameter_name} (${c.direction.toUpperCase()})`,
    secondary: `Request ${c.test_request_id.slice(0, 8)}`,
    meta: relativeAge(c.created_at),
    href: "/staff/critical-alerts",
  }));

  // There is no per-test detail page (only a PDF route under
  // /staff/results/[testRequestId]/pdf), so every row lands on the same
  // filtered archive list the card links to, rather than on the data-less
  // /staff/signoff placeholder.
  const signoffItems: ActivityItem[] = stats.pendingSignoff.map((s) => ({
    primary: pluckService(s.services),
    secondary: pluckPatientName(s.visits),
    href: "/staff/results?status=ready",
  }));

  const showMyQueue = role === "medtech" || role === "xray_technician";
  const showSignoff = role === "pathologist";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel={ROLE_LABEL[role]}
        title={ROLE_TITLE[role]}
      />

      <SectionHeading title="My queue">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {showMyQueue && show("lab.my_unclaimed") && (
          <StatCard
            label="Unclaimed in my sections"
            value={stats.myUnclaimed}
            hint="Requested or in progress, unassigned"
            href="/staff/queue"
            accent={stats.myUnclaimed > 0 ? "warn" : "default"}
          />
        )}
        {showMyQueue && show("lab.my_claimed") && (
          <StatCard
            label="Claimed by me"
            value={stats.myClaimed}
            hint="Assigned to me, in progress"
            href="/staff/queue?filter=mine"
          />
        )}
        {showSignoff && show("lab.ready_for_signoff") && (
          <StatCard
            label="Ready for sign-off"
            value={stats.readyForSignoff}
            hint="Sign-off screen not built yet"
            href="/staff/results?status=ready"
            accent={stats.readyForSignoff > 0 ? "warn" : "default"}
          />
        )}
        {showSignoff && show("lab.critical_alerts") && (
          <StatCard
            label="Critical alerts unacked"
            value={stats.criticalAlerts}
            hint="Patient safety priority"
            href="/staff/critical-alerts"
            accent={stats.criticalAlerts > 0 ? "warn" : "default"}
          />
        )}
        {role === "medtech" && show("lab.send_out_awaiting") && (
          <StatCard
            label="Send-out awaiting result"
            value={stats.sendOutAwaiting}
            hint="External labs still processing"
            href="/staff/queue"
          />
        )}
        {show("lab.released_today") && (
          <StatCard
            label="Released today (mine)"
            value={stats.releasedToday}
            hint="Tests fully released"
            href="/staff/queue?filter=released_today"
            accent="good"
          />
        )}
        </div>
      </SectionHeading>

      <SectionHeading title="Quicklinks">
        <QuickLinks items={buildQuickLinks(role)} />
      </SectionHeading>

      <SectionHeading title="What needs attention">
        <div className="grid gap-4 lg:grid-cols-2">
        {showMyQueue && show("lab.strip_oldest_unclaimed") && (
          <ActivityStrip
            title="Oldest unclaimed"
            items={oldestItems}
            emptyMessage="Nothing waiting in your queue."
            viewAllHref="/staff/queue"
          />
        )}
        {showSignoff && show("lab.strip_pending_signoff") && (
          <ActivityStrip
            title="Pending sign-off"
            items={signoffItems}
            emptyMessage="Sign-off queue is empty."
            viewAllHref="/staff/results?status=ready"
          />
        )}
        {(role === "medtech" || role === "pathologist") && show("lab.strip_recent_criticals") && (
          <ActivityStrip
            title="Recent critical alerts"
            items={criticalItems}
            emptyMessage="No critical alerts in last 24h."
            viewAllHref="/staff/critical-alerts"
          />
        )}
        </div>
      </SectionHeading>

      <SectionHeading
        title="Coming soon"
        subtitle="Modules on the roadmap for lab operations"
        defaultOpen={false}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {showSignoff && (
          <PlannedCard
            label="Sign-off screen"
            teaser="A dedicated worklist for reviewing and approving results before release, replacing today's placeholder page."
          />
        )}
        </div>
      </SectionHeading>
    </div>
  );
}
