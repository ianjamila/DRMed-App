import { quickLinksFor } from "@/components/staff/staff-nav-config";
import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { sectionsForRole, type ServiceSection } from "@/lib/auth/role-sections";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { todayManilaISODate } from "@/lib/dates/manila";
import { loadHiddenCardIds } from "@/lib/dashboards/card-prefs";
import { LAB_QUEUE_GATE_VISITS_OR } from "@/lib/visits/lab-gate";
import { reportError } from "@/lib/observability/report-error";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { DashboardHeader } from "./_components/dashboard-header";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
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
  // Only populated on the medtech query (ack status is shown there, not
  // filtered on) and the pathologist query (patient identification) —
  // optional so one type serves both `.returns<CriticalRow[]>()` calls.
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  patient_drm_id?: string | null;
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
          .eq("is_package_header", false)
          .in("services.section", sectionList)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
      : SKIP_COUNT;

  // The doctor-kind exclusion on this and the tiles below is deliberate
  // belt-and-braces. Each was safe only by an INVARIANT — "a doctor line
  // never gets an assigned_to", "a doctor line never reaches
  // result_uploaded" — and one such invariant has already turned out to be
  // false in this codebase (undoing a released consultation parks it at
  // `ready_for_release`, which the reception tile was counting). An invariant
  // that lives only in a comment is one refactor from being wrong; the filter
  // is one line and makes the tile correct by construction.
  //
  // Section filter + money gate added here too — without them a payment void
  // or a role change can leave a counted assignment that is absent from the
  // Mine tab it links to.
  const myClaimedPromise =
    show("lab.my_claimed") && (role === "medtech" || role === "xray_technician")
      ? supabase
          .from("test_requests")
          .select("id, services!inner(section), visits!inner(id)", { count: "exact", head: true })
          .eq("assigned_to", userId)
          .in("status", ["requested", "in_progress"])
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .in("services.section", sectionList)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
      : SKIP_COUNT;

  // "Ready for sign-off" surfaces results the pathologist hasn't looked at
  // yet — status = result_uploaded, i.e. a result was linked but hasn't
  // reached ready_for_release. /staff/signoff is a real route but a
  // data-less placeholder (UI queued for a later phase) — this card and the
  // "Pending sign-off" strip below both ship `defaultHidden: true` in
  // cards.ts until it exists, so admin has to opt back in from Dashboard
  // settings to see either. The card links to the working /staff/results
  // list instead of the placeholder.
  const readyForSignoffPromise =
    show("lab.ready_for_signoff") && role === "pathologist"
      ? supabase
          .from("test_requests")
          .select("id, services!inner(id), visits!inner(id)", { count: "exact", head: true })
          .eq("status", "result_uploaded")
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      : SKIP_COUNT;

  const criticalAlertsPromise =
    show("lab.critical_alerts") && role === "pathologist"
      ? supabase
          .from("critical_alerts")
          .select("id", { count: "exact", head: true })
          .is("acknowledged_at", null)
      : SKIP_COUNT;

  // Same money-settled gate as myUnclaimedPromise above — a send-out that
  // hasn't cleared payment isn't in the bench's worklist either. Section
  // filter + package-header exclusion added to match the queue's own
  // predicate set; the label says "tests" now (not "external labs still
  // processing"), because `requested` rows haven't even left the building.
  const sendOutAwaitingPromise =
    show("lab.send_out_awaiting") && role === "medtech"
      ? supabase
          .from("test_requests")
          .select("id, services!inner(is_send_out, section), visits!inner(id)", { count: "exact", head: true })
          .in("status", ["requested", "in_progress"])
          .eq("services.is_send_out", true)
          .eq("is_package_header", false)
          .in("services.section", sectionList)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      : SKIP_COUNT;

  // Shown to medtech, xray_technician AND pathologist (LAB_CAPABLE_ROLES —
  // pathologists can claim work too), so unlike every other section-gated
  // card on this dashboard this is the one query that has to handle
  // sectionsForRole's `null` (unrestricted) case rather than assume an array
  // — coercing null to `[]` here would wrongly deny pathologist every row.
  let releasedTodayQuery = supabase
    .from("test_requests")
    .select("id, services!inner(id, section), visits!inner(id)", {
      count: "exact",
      head: true,
    })
    .eq("status", "released")
    .eq("assigned_to", userId)
    .gte("released_at", startOfTodayUtc)
    .lt("released_at", startOfTomorrowUtc)
    .eq("is_package_header", false)
    // Same pair as every other tile on this dashboard — see the
    // admin dashboard's released-today tile for why "released implies
    // never deleted" is not an invariant the database enforces.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST);
  if (sections !== null) {
    releasedTodayQuery =
      sections.length === 0
        ? releasedTodayQuery.eq("id", "00000000-0000-0000-0000-000000000000")
        : releasedTodayQuery.in("services.section", sections);
  }
  const releasedTodayPromise = show("lab.released_today") ? releasedTodayQuery : SKIP_COUNT;

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
          .eq("is_package_header", false)
          .in("services.section", sectionList)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
          .order("requested_at", { ascending: true })
          .limit(5)
          .returns<QueueRow[]>()
      : SKIP_DATA;

  // Medtech: alerts on tests CURRENTLY assigned to them, any ack status —
  // read-only (acknowledging stays pathologist/admin per RLS 0027). No
  // existing query in the repo joins critical_alerts → test_requests, so the
  // `!inner` embed is load-bearing (a plain `services ( … )`-style LEFT join
  // would compile and silently return every alert, not just theirs) — see
  // the verification note in the PR description.
  const medtechCriticalsPromise =
    show("lab.strip_recent_criticals") && role === "medtech"
      ? supabase
          .from("critical_alerts")
          .select(
            "id, direction, created_at, test_request_id, parameter_name, acknowledged_at, acknowledged_by, test_requests!inner ( assigned_to )",
          )
          .eq("test_requests.assigned_to", userId)
          .order("created_at", { ascending: false })
          .limit(5)
          .returns<CriticalRow[]>()
      : SKIP_DATA;

  // Pathologist: unacknowledged only, oldest first — a handful of newer
  // acknowledged alerts used to displace urgent unresolved ones under the
  // old "last 24h, newest first" query, which also hid anything older than a
  // day while the count card beside it kept counting it. patient_drm_id is
  // selected so each row identifies the patient without an extra join.
  const pathologistCriticalsPromise =
    show("lab.strip_recent_criticals") && role === "pathologist"
      ? supabase
          .from("critical_alerts")
          .select("id, direction, created_at, test_request_id, parameter_name, patient_drm_id")
          .is("acknowledged_at", null)
          .order("created_at", { ascending: true })
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
            // `services!inner`, not `services` — a filter on a LEFT-joined
            // embed is silently ignored by PostgREST, so the doctor-kind
            // exclusion below would compile, run, and return the unfiltered
            // rows while looking like a working filter.
            "id, services!inner ( name ), visits!inner ( id, patients ( first_name, last_name ) )",
          )
          .eq("status", "result_uploaded")
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
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
    medtechCriticals,
    pathologistCriticals,
    pendingSignoff,
  ] = await Promise.all([
    myUnclaimedPromise,
    myClaimedPromise,
    readyForSignoffPromise,
    criticalAlertsPromise,
    sendOutAwaitingPromise,
    releasedTodayPromise,
    oldestUnclaimedPromise,
    medtechCriticalsPromise,
    pathologistCriticalsPromise,
    pendingSignoffPromise,
  ]);

  const recentCriticals = (
    role === "medtech"
      ? (medtechCriticals.data ?? [])
      : role === "pathologist"
        ? (pathologistCriticals.data ?? [])
        : []
  ) as CriticalRow[];
  const recentCriticalsError =
    role === "medtech" ? medtechCriticals.error : role === "pathologist" ? pathologistCriticals.error : null;

  // Resolve "acknowledged by" names for the medtech strip — read-only, so it
  // has to show who acted, not imply the medtech did (they only see this
  // because they hold the test, not because they handled the alert).
  const ackerNames = new Map<string, string>();
  if (role === "medtech") {
    const ackerIds = Array.from(
      new Set(
        recentCriticals
          .map((c) => c.acknowledged_by)
          .filter((v): v is string => !!v),
      ),
    );
    if (ackerIds.length > 0) {
      const { data: profs } = await supabase
        .from("staff_profiles")
        .select("id, full_name")
        .in("id", ackerIds);
      for (const p of profs ?? []) ackerNames.set(p.id, p.full_name);
    }
  }

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
    { scope: "recent_criticals", error: recentCriticalsError },
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
    myUnclaimedError: Boolean(myUnclaimed.error),
    myClaimed: myClaimed.count ?? 0,
    myClaimedError: Boolean(myClaimed.error),
    readyForSignoff: readyForSignoff.count ?? 0,
    readyForSignoffError: Boolean(readyForSignoff.error),
    criticalAlerts: criticalAlerts.count ?? 0,
    criticalAlertsError: Boolean(criticalAlerts.error),
    sendOutAwaiting: sendOutAwaiting.count ?? 0,
    sendOutAwaitingError: Boolean(sendOutAwaiting.error),
    releasedToday: releasedToday.count ?? 0,
    releasedTodayError: Boolean(releasedToday.error),
    oldestUnclaimed: (oldestUnclaimed.data ?? []) as QueueRow[],
    oldestUnclaimedError: Boolean(oldestUnclaimed.error),
    recentCriticals,
    recentCriticalsError: Boolean(recentCriticalsError),
    ackerNames,
    pendingSignoff: (pendingSignoff.data ?? []) as SignoffRow[],
    pendingSignoffError: Boolean(pendingSignoff.error),
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
    href: `/staff/queue/${r.id}`,
  }));

  // Critical alerts have their own worklist with the Acknowledge action —
  // send every entry point there instead of the general queue, which has
  // no critical-alert affordance at all.
  const criticalItems: ActivityItem[] = stats.recentCriticals.map((c) => {
    if (role === "medtech") {
      const ackedBy = c.acknowledged_by ? (stats.ackerNames.get(c.acknowledged_by) ?? "someone") : null;
      const ackLabel = c.acknowledged_at
        ? `Acknowledged ${relativeAge(c.acknowledged_at)}${ackedBy ? ` by ${ackedBy}` : ""}`
        : "Not yet acknowledged";
      return {
        primary: `${c.parameter_name} (${c.direction.toUpperCase()})`,
        secondary: ackLabel,
        meta: relativeAge(c.created_at),
        href: "/staff/critical-alerts",
      };
    }
    return {
      primary: `${c.parameter_name} (${c.direction.toUpperCase()})`,
      secondary: c.patient_drm_id ?? `Request ${c.test_request_id.slice(0, 8)}`,
      meta: relativeAge(c.created_at),
      href: "/staff/critical-alerts",
    };
  });

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
  const quickLinks = quickLinksFor(role, "lab");

  // Each SectionHeading below wraps its cards in a literal <div>, which is
  // always truthy — its own `if (!children)` check can never see "every card
  // in this section is hidden" from here. With sign-off's two cards
  // defaultHidden and role-gating trimming the rest, a section can now be
  // fully empty for a given role (e.g. pathologist with no lab.* overrides
  // sees no send-out/unclaimed/claimed cards at all). Compute per-section
  // visibility and skip rendering the SectionHeading entirely rather than
  // leave a bare heading over nothing.
  const showMyUnclaimedCard = showMyQueue && show("lab.my_unclaimed");
  const showMyClaimedCard = showMyQueue && show("lab.my_claimed");
  const showReadyForSignoffCard = showSignoff && show("lab.ready_for_signoff");
  const showCriticalAlertsCard = showSignoff && show("lab.critical_alerts");
  const showSendOutCard = role === "medtech" && show("lab.send_out_awaiting");
  const showReleasedTodayCard = show("lab.released_today");
  const hasMyQueueCards =
    showMyUnclaimedCard ||
    showMyClaimedCard ||
    showReadyForSignoffCard ||
    showCriticalAlertsCard ||
    showSendOutCard ||
    showReleasedTodayCard;

  const showOldestUnclaimedStrip = showMyQueue && show("lab.strip_oldest_unclaimed");
  const showPendingSignoffStrip = showSignoff && show("lab.strip_pending_signoff");
  const showMedtechCriticalsStrip = role === "medtech" && show("lab.strip_recent_criticals");
  const showPathologistCriticalsStrip = role === "pathologist" && show("lab.strip_recent_criticals");
  const hasAttentionCards =
    showOldestUnclaimedStrip ||
    showPendingSignoffStrip ||
    showMedtechCriticalsStrip ||
    showPathologistCriticalsStrip;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="lab-dashboard"
        subscriptions={[
          { table: "test_requests", event: "INSERT" },
          { table: "test_requests", event: "UPDATE" },
          { table: "critical_alerts", event: "INSERT" },
        ]}
      />
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel={ROLE_LABEL[role]}
        title={ROLE_TITLE[role]}
        updatedAt={new Date()}
      />

      {hasMyQueueCards && (
        <SectionHeading title="My queue">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {showMyUnclaimedCard && (
              <StatCard
                label="Unclaimed in my sections"
                value={stats.myUnclaimed}
                hint="Requested or in progress, unassigned"
                href="/staff/queue"
                accent={stats.myUnclaimed > 0 ? "warn" : "default"}
                error={stats.myUnclaimedError}
              />
            )}
            {showMyClaimedCard && (
              <StatCard
                label="Claimed by me"
                value={stats.myClaimed}
                hint="Assigned to me, in progress"
                href="/staff/queue?filter=mine"
                error={stats.myClaimedError}
              />
            )}
            {showReadyForSignoffCard && (
              <StatCard
                label="Ready for sign-off"
                value={stats.readyForSignoff}
                hint="Sign-off screen not built yet"
                href="/staff/results?status=ready"
                accent={stats.readyForSignoff > 0 ? "warn" : "default"}
                error={stats.readyForSignoffError}
              />
            )}
            {showCriticalAlertsCard && (
              <StatCard
                label="Critical alerts unacked"
                value={stats.criticalAlerts}
                hint="Patient safety priority"
                href="/staff/critical-alerts"
                accent={stats.criticalAlerts > 0 ? "warn" : "default"}
                error={stats.criticalAlertsError}
              />
            )}
            {showSendOutCard && (
              <StatCard
                label="Open send-out tests"
                value={stats.sendOutAwaiting}
                hint="Requested or in progress, sent to an external lab"
                href="/staff/queue"
                error={stats.sendOutAwaitingError}
              />
            )}
            {showReleasedTodayCard && (
              <StatCard
                label="Released today (mine)"
                value={stats.releasedToday}
                hint="Tests fully released"
                href="/staff/queue?filter=released_today&mine=1"
                accent="good"
                error={stats.releasedTodayError}
              />
            )}
          </div>
        </SectionHeading>
      )}

      {quickLinks.length > 0 && (
        <SectionHeading title="Quicklinks">
          <QuickLinks items={quickLinks} />
        </SectionHeading>
      )}

      {hasAttentionCards && (
        <SectionHeading title="What needs attention">
          <div className="grid gap-4 lg:grid-cols-2">
            {showOldestUnclaimedStrip && (
              <ActivityStrip
                title="Oldest unclaimed"
                items={oldestItems}
                emptyMessage="No unclaimed tests."
                viewAllHref="/staff/queue"
                error={stats.oldestUnclaimedError}
              />
            )}
            {showPendingSignoffStrip && (
              <ActivityStrip
                title="Pending sign-off"
                items={signoffItems}
                emptyMessage="Sign-off queue is empty."
                viewAllHref="/staff/results?status=ready"
                error={stats.pendingSignoffError}
              />
            )}
            {showMedtechCriticalsStrip && (
              <ActivityStrip
                title="Critical values on tests assigned to you"
                items={criticalItems}
                emptyMessage="No critical values on your tests right now."
                viewAllHref="/staff/critical-alerts"
                error={stats.recentCriticalsError}
              />
            )}
            {showPathologistCriticalsStrip && (
              <ActivityStrip
                title="Recent critical alerts"
                items={criticalItems}
                emptyMessage="No critical alerts awaiting acknowledgement."
                viewAllHref="/staff/critical-alerts"
                error={stats.recentCriticalsError}
              />
            )}
          </div>
        </SectionHeading>
      )}
    </div>
  );
}
