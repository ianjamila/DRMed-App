import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { TransitionButtons } from "./transition-buttons";
import { NewAppointmentSheet, type ServiceOption, type PhysicianOption } from "./new-appointment-sheet";
import { RegistrationLinkButton } from "@/components/staff/registration-link-button";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import {
  sectionTabsNavClass,
  sectionTabClass,
} from "@/components/staff/section-tabs-style";
import { LabRequestLinks, type LabRequestAttachment } from "./lab-request-links";
import { AppointmentsSearchInput } from "./appointments-search-input";
import {
  BUCKET_LABEL,
  BUCKET_STYLE,
  compareFlat,
  FLAT_DEFAULT_SORT,
  FLAT_SORTABLE_COLUMNS,
  groupHaystack,
  tagBucket,
  type BucketKey,
  type FlatSortColumn,
} from "./flat-view";
import { appointmentStatusLabel } from "@/lib/appointments/labels";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { matchesAllTokens } from "@/lib/patients/search";
import { manilaDateTime } from "@/lib/dates/manila";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = {
  title: "Appointments — staff",
};

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  pending_callback: "bg-amber-100 text-amber-900",
  confirmed: "bg-sky-100 text-sky-900",
  arrived: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-red-100 text-red-900",
  no_show: "bg-amber-100 text-amber-900",
  completed: "bg-slate-200 text-slate-700",
};

interface ApptRow {
  id: string;
  scheduled_at: string | null;
  created_at: string;
  status: string;
  notes: string | null;
  walk_in_name: string | null;
  walk_in_phone: string | null;
  patient_id: string | null;
  patient_drm_id: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  service_name: string | null;
  service_code: string | null;
  service_kind: string | null;
  physician_name: string | null;
  booking_group_id: string | null;
  home_service_requested: boolean;
}

interface ApptGroup {
  // Stable key: booking_group_id when present, otherwise the appointment id.
  key: string;
  // Lead row drives patient + scheduled_at + status display. All rows in a
  // group share these because the bulk transition action keeps them in sync.
  lead: ApptRow;
  rows: ApptRow[];
}

const APPT_SELECT = `
  id, scheduled_at, created_at, status, notes,
  walk_in_name, walk_in_phone, booking_group_id, home_service_requested,
  patients ( id, drm_id, first_name, last_name, phone ),
  services ( name, code, kind ),
  physicians ( full_name )
`;

// N13: named (not inline) so the paged loaders below can type their
// `fetchAllRows` fetcher without re-deriving this shape.
interface ApptSourceRow {
  id: string;
  scheduled_at: string | null;
  created_at: string;
  status: string;
  notes: string | null;
  walk_in_name: string | null;
  walk_in_phone: string | null;
  booking_group_id: string | null;
  home_service_requested: boolean;
  patients?:
    | {
        id: string;
        drm_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
      }
    | Array<{
        id: string;
        drm_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
      }>
    | null;
  services?:
    | { name: string; code: string; kind: string | null }
    | Array<{ name: string; code: string; kind: string | null }>
    | null;
  physicians?:
    | { full_name: string }
    | Array<{ full_name: string }>
    | null;
}

function rowFrom(a: ApptSourceRow): ApptRow {
  const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
  const s = Array.isArray(a.services) ? a.services[0] : a.services;
  const ph = Array.isArray(a.physicians) ? a.physicians[0] : a.physicians;
  return {
    id: a.id,
    scheduled_at: a.scheduled_at,
    created_at: a.created_at,
    status: a.status,
    notes: a.notes,
    walk_in_name: a.walk_in_name,
    walk_in_phone: a.walk_in_phone,
    patient_id: p?.id ?? null,
    patient_drm_id: p?.drm_id ?? null,
    patient_name: p ? `${p.last_name}, ${p.first_name}` : null,
    patient_phone: p?.phone ?? null,
    service_name: s?.name ?? null,
    service_code: s?.code ?? null,
    service_kind: s?.kind ?? null,
    physician_name: ph?.full_name ?? null,
    booking_group_id: a.booking_group_id,
    home_service_requested: a.home_service_requested,
  };
}

function groupRows(rows: ApptRow[]): ApptGroup[] {
  const groups: ApptGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const r of rows) {
    const key = r.booking_group_id ?? r.id;
    const idx = indexByKey.get(key);
    if (idx == null) {
      indexByKey.set(key, groups.length);
      groups.push({ key, lead: r, rows: [r] });
    } else {
      groups[idx]!.rows.push(r);
    }
  }
  return groups;
}

interface LoadedAppts {
  rows: ApptRow[];
  // True only if the open set genuinely exceeds REPORT_EXPORT_MAX_ROWS —
  // the page says so rather than silently dropping the remainder.
  truncated: boolean;
}

// N14: this was a bare `.select()` with `.order()` and no `.range()` — a
// plain PostgREST select silently caps at 1000 rows, the exact defect the
// comments on loadOpenWalkIns/loadPendingCallback below say was already
// fixed once for the other two loaders. Only ~98 appointment rows exist in
// production today so it wasn't yet biting, but "today" + "next 30 days"
// together are unbounded as the clinic grows, so it gets the same
// fetchAllRows treatment: walk the range in 1000-row pages up to
// REPORT_EXPORT_MAX_ROWS, oldest-scheduled-first, with an id tie-break so
// `.range()` can't drop or repeat a row across pages.
async function loadScheduledRange(
  fromIso: string,
  toIso: string,
): Promise<LoadedAppts> {
  const supabase = await createClient();
  const { rows, truncated } = await fetchAllRows<ApptSourceRow>(
    (rFrom, rTo) =>
      supabase
        .from("appointments")
        .select(APPT_SELECT)
        .gte("scheduled_at", fromIso)
        .lt("scheduled_at", toIso)
        .order("scheduled_at", { ascending: true })
        .order("id", { ascending: true })
        .range(rFrom, rTo)
        .returns<ApptSourceRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  return { rows: rows.map(rowFrom), truncated };
}

async function loadOpenWalkIns(): Promise<LoadedAppts> {
  // Confirmed OR arrived appointments with no specific scheduled_at — the
  // diagnostic-package / untimed-lab-request walk-in path (every public
  // lab-request booking has scheduled_at = null). Loaded by OPEN STATUS,
  // not "created today" (N12): a walk-in booked yesterday afternoon is
  // still waiting this morning and must not vanish from the page. "arrived"
  // is included (A9): marking a walk-in arrived used to drop it out of
  // every section on this page — no section selected on scheduled_at AND
  // status = confirmed once status flips to arrived — which stranded "+
  // Start visit" (only rendered for arrived rows) and left the appointment
  // stuck at arrived forever.
  //
  // N13: these are appointment ROWS, not bookings — a three-service booking
  // is three rows sharing one booking_group_id — so a flat `.limit(100)`
  // both dropped the OLDEST waiting walk-ins (newest-first + a hard cap
  // means the longest-waiting patient is the first to disappear) and could
  // cut a multi-service booking in half at the boundary. `fetchAllRows`
  // walks the whole open set in 1000-row PostgREST pages (a plain select
  // silently caps there) up to REPORT_EXPORT_MAX_ROWS, so every currently
  // open booking comes back whole and oldest-first, matching how reception
  // should work the queue; a page component banner covers the (practically
  // unreachable, for a live "still open" set) case where that ceiling bites.
  const supabase = await createClient();
  const { rows, truncated } = await fetchAllRows<ApptSourceRow>(
    (rFrom, rTo) =>
      supabase
        .from("appointments")
        .select(APPT_SELECT)
        .is("scheduled_at", null)
        .in("status", ["confirmed", "arrived"])
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(rFrom, rTo)
        .returns<ApptSourceRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  return { rows: rows.map(rowFrom), truncated };
}

async function loadPendingCallback(): Promise<LoadedAppts> {
  // N13: same paging rationale as loadOpenWalkIns above — oldest first, the
  // shared report pager instead of a row-count cap.
  const supabase = await createClient();
  const { rows, truncated } = await fetchAllRows<ApptSourceRow>(
    (rFrom, rTo) =>
      supabase
        .from("appointments")
        .select(APPT_SELECT)
        .eq("status", "pending_callback")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(rFrom, rTo)
        .returns<ApptSourceRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  return { rows: rows.map(rowFrom), truncated };
}

type FilterType = "all" | "consult" | "home";

const FILTER_TABS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "consult", label: "Consultations" },
  { value: "home", label: "Home service" },
];

function applyFilter(groups: ApptGroup[], type: FilterType): ApptGroup[] {
  if (type === "all") return groups;
  if (type === "home") {
    return groups.filter((g) =>
      g.rows.some((r) => r.home_service_requested),
    );
  }
  // consult: any row has kind = doctor_consultation AND the group is NOT a
  // home-service group (keep buckets mutually exclusive).
  return groups.filter(
    (g) =>
      !g.rows.some((r) => r.home_service_requested) &&
      g.rows.some((r) => r.service_kind === "doctor_consultation"),
  );
}

// A group tagged with which of the four loaders it came from — shown as a
// badge in the flat search/sort view, where groups from all four sections
// are mixed together (the badge is how reception tells them apart once
// they're no longer under their own section heading). `BucketKey`,
// `BUCKET_LABEL`/`BUCKET_STYLE`, `tagBucket`, `groupHaystack`,
// `FLAT_SORTABLE_COLUMNS`/`FlatSortColumn`, `FLAT_DEFAULT_SORT` and
// `compareFlat` all live in `./flat-view.ts` — pure logic, vitest-tested,
// with no dependency on this page's DB-shaped types.
interface BucketedGroup extends ApptGroup {
  bucket: BucketKey;
}

interface SearchProps {
  searchParams: Promise<{
    type?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

const BASE_PATH = "/staff/appointments";

export default async function AppointmentsPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const sp = await searchParams;
  const type: FilterType =
    sp.type === "consult" || sp.type === "home" ? sp.type : "all";
  const typeParam = type === "all" ? null : type;

  // The flat/sorted view and the grouped default view are mutually
  // exclusive — see the doc comment on FlatTable below for why. Presence of
  // `?sort=` (however it got there — a column click, or the "Sort this
  // list" link) is what keeps the page in flat mode across further link
  // clicks, so it — unlike every other param here — is never omitted from
  // a built href once flat mode is active, even when it names the default
  // column/direction.
  const query = (sp.q ?? "").trim();
  const hasExplicitSort = typeof sp.sort === "string" && sp.sort.length > 0;
  const isFlatView = query.length > 0 || hasExplicitSort;
  const sort = parseSort(sp.sort, sp.dir, FLAT_SORTABLE_COLUMNS, FLAT_DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  // eslint-disable-next-line react-hooks/purity -- per-request bounds.
  const nowMs = Date.now();
  const manilaToday = new Date(nowMs + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const startOfTodayUtc = new Date(`${manilaToday}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const endOfRangeUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 31 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [todayResult, walkInsResult, upcomingResult, pendingResult] = await Promise.all([
    loadScheduledRange(startOfTodayUtc, startOfTomorrowUtc),
    loadOpenWalkIns(),
    loadScheduledRange(startOfTomorrowUtc, endOfRangeUtc),
    loadPendingCallback(),
  ]);
  const todayScheduled = todayResult.rows;
  const openWalkIns = walkInsResult.rows;
  const upcoming = upcomingResult.rows;
  const pending = pendingResult.rows;
  const anyTruncated =
    pendingResult.truncated ||
    walkInsResult.truncated ||
    todayResult.truncated ||
    upcomingResult.truncated;

  const supabase = await createClient();
  const [{ data: serviceRows }, { data: physicianRows }] = await Promise.all([
    supabase.from("services").select("id, name, kind, requires_time_slot").eq("is_active", true).order("name", { ascending: true }),
    supabase.from("physicians").select("id, full_name").eq("is_active", true).order("full_name", { ascending: true }),
  ]);
  const services: ServiceOption[] = serviceRows ?? [];
  const physicians: PhysicianOption[] = physicianRows ?? [];

  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const selfBookUrl = `${proto}://${host}/schedule?src=staff_qr`;
  const registerUrl = `${proto}://${host}/register?src=staff_qr`;

  // Build full (unfiltered) groups for each section — used for tab counts.
  const allPendingGroups = groupRows(pending);
  const allWalkInGroups = groupRows(openWalkIns);
  const allTodayGroups = groupRows(todayScheduled);
  const allUpcomingGroups = groupRows(upcoming);

  const groupIds = Array.from(
    new Set(
      [...allPendingGroups, ...allWalkInGroups, ...allTodayGroups, ...allUpcomingGroups]
        .map((g) => g.lead.booking_group_id)
        .filter((id): id is string => !!id),
    ),
  );
  const attachmentsByGroup = new Map<string, LabRequestAttachment[]>();
  if (groupIds.length > 0) {
    const { data: attachRows } = await supabase
      .from("appointment_attachments")
      .select("id, filename, booking_group_id")
      .in("booking_group_id", groupIds);
    for (const a of attachRows ?? []) {
      const list = attachmentsByGroup.get(a.booking_group_id) ?? [];
      list.push({ id: a.id, filename: a.filename });
      attachmentsByGroup.set(a.booking_group_id, list);
    }
  }

  // Counts shown in tab labels — union of all four sections.
  function countForTab(t: FilterType): number {
    return (
      applyFilter(allPendingGroups, t).length +
      applyFilter(allWalkInGroups, t).length +
      applyFilter(allTodayGroups, t).length +
      applyFilter(allUpcomingGroups, t).length
    );
  }

  // Filtered groups for the active tab.
  const pendingGroups = applyFilter(allPendingGroups, type);
  const walkInGroups = applyFilter(allWalkInGroups, type);
  const todayGroups = applyFilter(allTodayGroups, type);
  const upcomingGroups = applyFilter(allUpcomingGroups, type);

  // Flat/sorted view: one table mixing all four sections, tagged with which
  // section each row came from. Built from the SAME already-fully-loaded
  // (fetchAllRows, up to REPORT_EXPORT_MAX_ROWS) row sets the grouped view
  // uses — nothing extra is fetched for search or sort, and nothing here can
  // silently miss a row that the grouped view would have shown, because the
  // "q" search box's ILIKE-style match runs on that same complete in-memory
  // set (`groupHaystack` / `matchesAllTokens`) rather than as a database
  // filter. That's the part this page genuinely cannot push into the
  // database query in one round trip: PostgREST can't ILIKE across an
  // *embedded* resource (the `patients` join) without an inner join that
  // would also silently drop every walk-in row (they have no patient to
  // join to) — see `groupHaystack`'s doc comment. Sorting is likewise
  // applied in JS, not a PostgREST `.order()` — the data is already fully
  // materialised, so there is nothing left to push down.
  let flatGroups: BucketedGroup[] = [];
  let flatTotal = 0;
  let flatTotalPages = 1;
  if (isFlatView) {
    const combined: BucketedGroup[] = [
      ...tagBucket(pendingGroups, "pending"),
      ...tagBucket(walkInGroups, "walkin"),
      ...tagBucket(todayGroups, "today"),
      ...tagBucket(upcomingGroups, "upcoming"),
    ];
    const searched = query
      ? combined.filter((g) => matchesAllTokens(groupHaystack(g), query))
      : combined;
    const sorted = [...searched].sort((a, b) => compareFlat(a, b, sort));
    flatTotal = sorted.length;
    flatTotalPages = pageCount(flatTotal, size);
    const [from, to] = rangeFor(page, size);
    flatGroups = sorted.slice(from, to + 1);
  }

  // Every param this page's links round-trip, at its default omitted so
  // page 1 with no search/sort stays the bare /staff/appointments?type=…
  // URL. `sort`/`dir` are the one exception (see the `isFlatView` comment
  // above) — they're kept once flat mode is active even at their default
  // value, since their PRESENCE is what keeps the page in flat mode.
  const baseParams: Record<string, string | null> = {
    type: typeParam,
    q: query || null,
    sort: isFlatView ? sort.key : null,
    dir: isFlatView ? sort.dir : null,
    size: isFlatView && size !== DEFAULT_PAGE_SIZE ? String(size) : null,
  };

  const tabHref = (t: FilterType) =>
    buildListHref(BASE_PATH, baseParams, { type: t === "all" ? null : t, page: null });

  const sortHref = (key: FlatSortColumn) => {
    const next = nextSort(sort, key);
    // Any change to sort resets to page 1 — staying on page 7 of a result
    // set that just reordered is a blank screen with no explanation.
    return buildListHref(BASE_PATH, baseParams, { sort: next.key, dir: next.dir, page: null });
  };

  // Opts into the flat view without a search term — column headers only
  // exist inside the flat table, so this is how a column gets sorted for
  // the very first time.
  const enterFlatHref = buildListHref(
    BASE_PATH,
    { type: typeParam },
    { sort: FLAT_DEFAULT_SORT.key, dir: FLAT_DEFAULT_SORT.dir },
  );
  // Drops q/sort/dir/page/size entirely — back to the grouped default.
  const exitFlatHref = buildListHref(BASE_PATH, { type: typeParam }, {});

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="appointments-page"
        subscriptions={[
          { table: "appointments", event: "INSERT" },
          { table: "appointments", event: "UPDATE" },
        ]}
      />
      <PageHeader
        title="Appointments"
        subtitle="Public bookings from /schedule plus staff-created appointments. Multi-service requests are grouped — one card with all picked tests, single set of action buttons."
        actions={
          <>
            <RegistrationLinkButton url={registerUrl} />
            <NewAppointmentSheet services={services} physicians={physicians} selfBookUrl={selfBookUrl} />
          </>
        }
      />

      {/* Search + the grouped/sorted toggle get their own row below the
          header, never inside PageHeader's `actions` — actions sit beside
          the subtitle in one flex row, so a control there jumps up/down
          whenever the subtitle's rendered length changes (drmed-staff-ui
          skill, §4a rule 2). Neither of these varies the subtitle, so both
          are safe here regardless. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <AppointmentsSearchInput initialQuery={query} />
        {isFlatView ? (
          <Link
            href={exitFlatHref}
            className="text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            ← Back to grouped view
          </Link>
        ) : (
          <Link
            href={enterFlatHref}
            className="text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Sort this list →
          </Link>
        )}
      </div>
      {isFlatView ? (
        <p className="mb-4 text-xs text-[color:var(--color-brand-text-soft)]">
          Search checks the patient&apos;s name, DRM-ID and phone, or the
          walk-in name and phone. It covers pending callbacks, walk-ins
          waiting, today, and the next 30 days — the same appointments this
          page always shows — so it won&apos;t find older, cancelled, or
          already-completed appointments.
        </p>
      ) : null}

      <nav className={sectionTabsNavClass} aria-label="Appointment type filter">
        {FILTER_TABS.map((tab) => {
          const active = type === tab.value;
          return (
            <Link
              key={tab.value}
              href={tabHref(tab.value)}
              className={sectionTabClass(active)}
              aria-current={active ? "page" : undefined}
            >
              {tab.label} ({countForTab(tab.value)})
            </Link>
          );
        })}
      </nav>

      {isFlatView ? (
        <>
          {anyTruncated ? (
            <p
              role="status"
              className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} appointment
              rows from one or more sections — there are more than that still open or
              scheduled, so this list and search may not cover every one.
            </p>
          ) : null}
          <FlatTable
            groups={flatGroups}
            sort={sort}
            sortHref={sortHref}
            isAdmin={session.role === "admin"}
            attachmentsByGroup={attachmentsByGroup}
          />
          <ListPagination
            page={page}
            pageCount={flatTotalPages}
            total={flatTotal}
            size={size}
            prevHref={
              page > 1
                ? buildListHref(BASE_PATH, baseParams, {
                    page: page - 1 > 1 ? String(page - 1) : null,
                  })
                : null
            }
            nextHref={
              page < flatTotalPages
                ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) })
                : null
            }
            sizeOptions={PAGE_SIZES.map((s) => ({
              size: s,
              href: buildListHref(BASE_PATH, baseParams, {
                size: s === DEFAULT_PAGE_SIZE ? null : String(s),
                page: null,
              }),
            }))}
            noun="appointment"
          />
        </>
      ) : (
        <>
          <Section
            title={`Pending callback (${pendingGroups.length})`}
            groups={pendingGroups}
            empty="No pending callbacks. Nice."
            isAdmin={session.role === "admin"}
            attachmentsByGroup={attachmentsByGroup}
            truncatedNotice={
              pendingResult.truncated
                ? `Showing the first ${REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} pending-callback appointment rows (oldest first) — there are more than that still open.`
                : null
            }
          />
          <Section
            title={`Walk-ins waiting (${walkInGroups.length})`}
            groups={walkInGroups}
            empty="No walk-ins waiting — diagnostic packages and untimed lab requests land here until reception acts on them."
            isAdmin={session.role === "admin"}
            attachmentsByGroup={attachmentsByGroup}
            truncatedNotice={
              walkInsResult.truncated
                ? `Showing the first ${REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} walk-in appointment rows (oldest first) — there are more than that still open.`
                : null
            }
          />
          <Section
            title={`Today (${todayGroups.length})`}
            groups={todayGroups}
            empty="No appointments today."
            isAdmin={session.role === "admin"}
            attachmentsByGroup={attachmentsByGroup}
            truncatedNotice={
              todayResult.truncated
                ? `Showing the first ${REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} of today's appointment rows (earliest first) — there are more than that today.`
                : null
            }
          />
          <Section
            title={`Next 30 days (${upcomingGroups.length})`}
            groups={upcomingGroups}
            empty="No upcoming appointments."
            isAdmin={session.role === "admin"}
            attachmentsByGroup={attachmentsByGroup}
            truncatedNotice={
              upcomingResult.truncated
                ? `Showing the first ${REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} upcoming appointment rows (earliest first) — there are more than that in the next 30 days.`
                : null
            }
          />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  groups,
  empty,
  isAdmin,
  attachmentsByGroup,
  truncatedNotice = null,
}: {
  title: string;
  groups: ApptGroup[];
  empty: string;
  isAdmin: boolean;
  attachmentsByGroup: Map<string, LabRequestAttachment[]>;
  // N13: set only when the loader's row ceiling actually bit — never silent.
  truncatedNotice?: string | null;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-3 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      {truncatedNotice ? (
        <p
          role="status"
          className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {truncatedNotice}
        </p>
      ) : null}
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Services</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {groups.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {empty}
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <GroupRow
                  key={g.key}
                  group={g}
                  isAdmin={isAdmin}
                  attachments={
                    g.lead.booking_group_id
                      ? attachmentsByGroup.get(g.lead.booking_group_id) ?? []
                      : []
                  }
                />
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

/**
 * The flat/sorted view: all four sections merged into one table, with a
 * "From" badge (see BUCKET_LABEL/BUCKET_STYLE) standing in for the section
 * heading each row lost by being mixed in with the other three. Column
 * headers are real `SortableTh` links — sorting across sections is only
 * meaningful once they're merged like this, which is why the grouped
 * default view has no sort controls at all.
 */
function FlatTable({
  groups,
  sort,
  sortHref,
  isAdmin,
  attachmentsByGroup,
}: {
  groups: BucketedGroup[];
  sort: SortSpec<FlatSortColumn>;
  sortHref: (key: FlatSortColumn) => string;
  isAdmin: boolean;
  attachmentsByGroup: Map<string, LabRequestAttachment[]>;
}) {
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <SortableTh
              label="Requested"
              href={sortHref("created_at")}
              state={ariaSortFor(sort, "created_at")}
            />
            <SortableTh
              label="When"
              href={sortHref("scheduled_at")}
              state={ariaSortFor(sort, "scheduled_at")}
            />
            <SortableTh
              label="Patient"
              href={sortHref("patient")}
              state={ariaSortFor(sort, "patient")}
            />
            <PlainTh label="Services" />
            <SortableTh label="Status" href={sortHref("status")} state={ariaSortFor(sort, "status")} />
            <PlainTh label="From" />
            <PlainTh label="Action" align="right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {groups.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
              >
                No appointments match.
              </td>
            </tr>
          ) : (
            groups.map((g) => (
              <GroupRow
                key={g.key}
                group={g}
                isAdmin={isAdmin}
                bucket={g.bucket}
                attachments={
                  g.lead.booking_group_id
                    ? attachmentsByGroup.get(g.lead.booking_group_id) ?? []
                    : []
                }
              />
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function GroupRow({
  group,
  isAdmin,
  attachments,
  bucket,
}: {
  group: ApptGroup;
  isAdmin: boolean;
  attachments: LabRequestAttachment[];
  // Only set from FlatTable — renders an extra "From" cell so a row mixed
  // in with the other three sections still says which one it came from.
  bucket?: BucketKey;
}) {
  const r = group.lead;
  const ids = group.rows.map((row) => row.id);
  return (
    <tr className="align-top hover:bg-[color:var(--color-brand-bg)]">
      <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-soft)]">
        {manilaDateTime(r.created_at)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-[color:var(--color-brand-text-mid)]">
        {r.scheduled_at ? (
          manilaDateTime(r.scheduled_at)
        ) : r.status === "pending_callback" ? (
          <span className="text-xs italic text-amber-700">
            Pending callback
          </span>
        ) : (
          <span className="text-xs italic text-sky-700">Walk-in</span>
        )}
      </td>
      <td className="px-4 py-3">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">
          {r.patient_id ? (
            <Link
              href={`/staff/patients/${r.patient_id}`}
              className="hover:text-[color:var(--color-brand-cyan)]"
            >
              {r.patient_name}
            </Link>
          ) : (
            <span>{r.walk_in_name ?? "Walk-in"}</span>
          )}
        </p>
        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {r.patient_drm_id ?? r.walk_in_phone ?? r.patient_phone ?? "—"}
        </p>
        {r.home_service_requested ? (
          <p className="mt-1 inline-block rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-900">
            Home service
          </p>
        ) : null}
        <LabRequestLinks attachments={attachments} />
      </td>
      <td className="px-4 py-3">
        {group.rows.length === 1 ? (
          <>
            <p className="font-semibold text-[color:var(--color-brand-navy)]">
              {r.service_name ?? "—"}
            </p>
            <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
              {r.service_code ?? ""}
            </p>
            {r.physician_name ? (
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-mid)]">
                with <span className="font-semibold">{r.physician_name}</span>
              </p>
            ) : null}
          </>
        ) : (
          <ul className="space-y-1">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="text-[color:var(--color-brand-text-mid)]"
              >
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {row.service_name ?? "—"}
                </span>
                <span className="ml-2 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {row.service_code ?? ""}
                </span>
                {row.physician_name ? (
                  <span className="ml-2 text-xs text-[color:var(--color-brand-text-mid)]">
                    · {row.physician_name}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
            STATUS_STYLE[r.status] ?? ""
          }`}
        >
          {appointmentStatusLabel(r.status)}
        </span>
      </td>
      {bucket ? (
        <td className="px-4 py-3">
          <span
            className={`rounded-md px-2 py-0.5 text-xs font-semibold ${BUCKET_STYLE[bucket]}`}
          >
            {BUCKET_LABEL[bucket]}
          </span>
        </td>
      ) : null}
      <td className="px-4 py-3 text-right">
        <TransitionButtons
          appointmentIds={ids}
          patientId={r.patient_id}
          walkInName={r.walk_in_name}
          walkInPhone={r.walk_in_phone}
          status={r.status}
          isAdmin={isAdmin}
          groupSize={group.rows.length}
        />
      </td>
    </tr>
  );
}
