import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { sectionsForRole, type ServiceSection } from "@/lib/auth/role-sections";
import { todayManilaISODate } from "@/lib/dates/manila";
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
  return links;
}

type QueueRow = {
  id: string;
  status: string;
  requested_at: string;
  patients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  services: { name: string; section: string | null } | { name: string; section: string | null }[] | null;
};

type SignoffRow = {
  id: string;
  patients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
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

function pluckService<T extends { name: string }>(v: T | T[] | null): string {
  if (!v) return "—";
  const row = Array.isArray(v) ? v[0] : v;
  return row?.name ?? "—";
}

async function loadLabStats(role: Role, userId: string) {
  const supabase = await createClient();
  const today = todayManilaISODate();
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();
  const sections = sectionsForRole(role);
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const usesSectionFilter = sections !== null && sections.length > 0;

  // Build per-section filter only for medtech/xray. Pathologist/admin pass
  // through unfiltered (sections === null).
  const sectionList = (sections ?? []) as ServiceSection[];

  const myUnclaimedPromise =
    role === "medtech" || role === "xray_technician"
      ? supabase
          .from("test_requests")
          .select("id, services!inner(section)", { count: "exact", head: true })
          .in("status", ["requested", "in_progress"])
          .is("assigned_to", null)
          .in("services.section", sectionList)
      : Promise.resolve({ count: 0, data: null });

  const myClaimedPromise =
    role === "medtech" || role === "xray_technician"
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", userId)
          .in("status", ["requested", "in_progress"])
      : Promise.resolve({ count: 0, data: null });

  const readyForSignoffPromise =
    role === "pathologist" || role === "admin"
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "ready_for_release")
      : Promise.resolve({ count: 0, data: null });

  const criticalAlertsPromise =
    role === "pathologist" || role === "admin"
      ? supabase
          .from("critical_alerts")
          .select("id", { count: "exact", head: true })
          .is("acknowledged_at", null)
      : Promise.resolve({ count: 0, data: null });

  const sendOutAwaitingPromise =
    role === "medtech"
      ? supabase
          .from("test_requests")
          .select("id, services!inner(is_send_out)", { count: "exact", head: true })
          .in("status", ["requested", "in_progress"])
          .eq("services.is_send_out", true)
      : Promise.resolve({ count: 0, data: null });

  const releasedTodayMinePromise =
    role === "medtech" || role === "xray_technician" || role === "pathologist"
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "released")
          .eq("assigned_to", userId)
          .gte("released_at", startOfTodayUtc)
          .lt("released_at", startOfTomorrowUtc)
      : Promise.resolve({ count: 0, data: null });

  const releasedTodayAllPromise =
    role === "admin"
      ? supabase
          .from("test_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "released")
          .gte("released_at", startOfTodayUtc)
          .lt("released_at", startOfTomorrowUtc)
      : Promise.resolve({ count: 0, data: null });

  // Activity strip: oldest unclaimed in my sections (medtech/xray)
  const oldestUnclaimedPromise =
    role === "medtech" || role === "xray_technician"
      ? supabase
          .from("test_requests")
          .select(
            "id, status, requested_at, patients ( first_name, last_name ), services!inner ( name, section )",
          )
          .in("status", ["requested", "in_progress"])
          .is("assigned_to", null)
          .in("services.section", sectionList)
          .order("requested_at", { ascending: true })
          .limit(5)
          .returns<QueueRow[]>()
      : Promise.resolve({ data: null });

  // Activity strip: recently flagged abnormal (medtech)
  const recentCriticalsPromise =
    role === "medtech" || role === "pathologist" || role === "admin"
      ? supabase
          .from("critical_alerts")
          .select("id, direction, created_at, test_request_id, parameter_name")
          .gte("created_at", dayAgoIso)
          .order("created_at", { ascending: false })
          .limit(5)
          .returns<CriticalRow[]>()
      : Promise.resolve({ data: null });

  // Activity strip: pending sign-off (pathologist/admin)
  const pendingSignoffPromise =
    role === "pathologist" || role === "admin"
      ? supabase
          .from("test_requests")
          .select(
            "id, patients ( first_name, last_name ), services ( name )",
          )
          .eq("status", "ready_for_release")
          .order("requested_at", { ascending: true })
          .limit(5)
          .returns<SignoffRow[]>()
      : Promise.resolve({ data: null });

  const [
    myUnclaimed,
    myClaimed,
    readyForSignoff,
    criticalAlerts,
    sendOutAwaiting,
    releasedTodayMine,
    releasedTodayAll,
    oldestUnclaimed,
    recentCriticals,
    pendingSignoff,
  ] = await Promise.all([
    myUnclaimedPromise,
    myClaimedPromise,
    readyForSignoffPromise,
    criticalAlertsPromise,
    sendOutAwaitingPromise,
    releasedTodayMinePromise,
    releasedTodayAllPromise,
    oldestUnclaimedPromise,
    recentCriticalsPromise,
    pendingSignoffPromise,
  ]);

  return {
    myUnclaimed: myUnclaimed.count ?? 0,
    myClaimed: myClaimed.count ?? 0,
    readyForSignoff: readyForSignoff.count ?? 0,
    criticalAlerts: criticalAlerts.count ?? 0,
    sendOutAwaiting: sendOutAwaiting.count ?? 0,
    releasedToday:
      role === "admin" ? (releasedTodayAll.count ?? 0) : (releasedTodayMine.count ?? 0),
    oldestUnclaimed: oldestUnclaimed.data ?? [],
    recentCriticals: recentCriticals.data ?? [],
    pendingSignoff: pendingSignoff.data ?? [],
    usesSectionFilter,
  };
}

export async function LabDashboard({ session }: { session: StaffSession }) {
  const role = session.role;
  const stats = await loadLabStats(role, session.user_id);

  const oldestItems: ActivityItem[] = stats.oldestUnclaimed.map((r) => ({
    primary: pluckService(r.services),
    secondary: pluckName(r.patients),
    meta: relativeAge(r.requested_at),
    href: "/staff/queue",
  }));

  const criticalItems: ActivityItem[] = stats.recentCriticals.map((c) => ({
    primary: `${c.parameter_name} (${c.direction.toUpperCase()})`,
    secondary: `Request ${c.test_request_id.slice(0, 8)}`,
    meta: relativeAge(c.created_at),
    href: "/staff/queue",
  }));

  const signoffItems: ActivityItem[] = stats.pendingSignoff.map((s) => ({
    primary: pluckService(s.services),
    secondary: pluckName(s.patients),
    href: "/staff/signoff",
  }));

  const showMyQueue = role === "medtech" || role === "xray_technician";
  const showSignoff = role === "pathologist" || role === "admin";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel={ROLE_LABEL[role]}
        title={ROLE_TITLE[role]}
      />

      <SectionHeading title="My queue" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {showMyQueue ? (
          <>
            <StatCard
              label="Unclaimed in my sections"
              value={stats.myUnclaimed}
              hint="Requested or in progress, unassigned"
              href="/staff/queue"
              accent={stats.myUnclaimed > 0 ? "warn" : "default"}
            />
            <StatCard
              label="Claimed by me"
              value={stats.myClaimed}
              hint="Assigned to me, in progress"
              href="/staff/queue?filter=mine"
            />
          </>
        ) : null}
        {showSignoff ? (
          <>
            <StatCard
              label="Ready for sign-off"
              value={stats.readyForSignoff}
              hint="Awaiting pathologist release"
              href="/staff/signoff"
              accent={stats.readyForSignoff > 0 ? "warn" : "default"}
            />
            <StatCard
              label="Critical alerts unacked"
              value={stats.criticalAlerts}
              hint="Patient safety priority"
              href="/staff/queue"
              accent={stats.criticalAlerts > 0 ? "warn" : "default"}
            />
          </>
        ) : null}
        {role === "medtech" ? (
          <StatCard
            label="Send-out awaiting result"
            value={stats.sendOutAwaiting}
            hint="External labs still processing"
            href="/staff/queue"
          />
        ) : null}
        <StatCard
          label={role === "admin" ? "Released today" : "Released today (mine)"}
          value={stats.releasedToday}
          hint="Tests fully released"
          href="/staff/queue?filter=released_today"
          accent="good"
        />
      </div>

      <SectionHeading title="Quicklinks" />
      <QuickLinks items={buildQuickLinks(role)} />

      <SectionHeading title="What needs attention" />
      <div className="grid gap-4 lg:grid-cols-2">
        {showMyQueue ? (
          <ActivityStrip
            title="Oldest unclaimed"
            items={oldestItems}
            emptyMessage="Nothing waiting in your queue."
            viewAllHref="/staff/queue"
          />
        ) : null}
        {showSignoff ? (
          <ActivityStrip
            title="Pending sign-off"
            items={signoffItems}
            emptyMessage="Sign-off queue is empty."
            viewAllHref="/staff/signoff"
          />
        ) : null}
        <ActivityStrip
          title="Recent critical alerts"
          items={criticalItems}
          emptyMessage="No critical alerts in last 24h."
          viewAllHref="/staff/queue"
        />
      </div>

      <SectionHeading
        title="Coming soon"
        subtitle="Modules on the roadmap for lab operations"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <PlannedCard
          label="Reagent inventory"
          teaser="Stock levels, expiry alerts, reorder thresholds by section"
          module="inventory"
        />
        <PlannedCard
          label="Send-out vendor performance"
          teaser="TAT, cost, SLA compliance, and rejection rate per external lab"
          module="send-out-performance"
        />
        <PlannedCard
          label="Turnaround analytics"
          teaser="Per-section TAT trends and SLA breaches"
          module="tat-analytics"
        />
      </div>
    </div>
  );
}
