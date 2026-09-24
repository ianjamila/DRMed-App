import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import {
  canClaimSection,
  claimOwnerLabel,
  claimOwnerRole,
  queueTitleForRole,
  sectionsForRole,
} from "@/lib/auth/role-sections";
import { RealtimeRefresher, type Subscription } from "@/components/staff/realtime-refresher";
import { ClaimButton } from "./claim-button";
import { QueueUnclaimButton } from "./queue-unclaim-button";
import {
  claimRemarks,
  MAX_REMARKS_SHOWN,
  type ClaimEvent,
} from "@/lib/queue/claim-remarks";
import { fetchClaimEvents } from "@/lib/queue/fetch-claim-events";
import { ClaimRemarksList } from "@/components/staff/claim-remarks-list";
import { sectionTabClass, sectionTabsNavClass } from "@/components/staff/section-tabs-style";
import { PageHeader } from "@/components/staff/page-header";
import {
  ariaSortFor,
  buildListHref,
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
import { Panel } from "@/components/ui/panel";
import {
  isISODate,
  manilaDateTime,
  manilaDayWindowUtc,
  manilaRangeUtc,
  todayManilaISODate,
} from "@/lib/dates/manila";
import { matchesAllTokens } from "@/lib/patients/search";
import { visitNumberFilter } from "@/lib/visits/visit-number-filter";
import { testDeletability, hasOpenHmoClaim } from "@/lib/visits/deletion";
import { LAB_QUEUE_GATE_VISITS_OR } from "@/lib/visits/lab-gate";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { QueueDeleteDialog } from "@/components/staff/queue-delete-dialog";

const LAB_QUEUE_SUBSCRIPTIONS = [
  { table: "test_requests", event: "INSERT" },
  { table: "test_requests", event: "UPDATE" },
] as const satisfies readonly Subscription[];

// ---------------------------------------------------------------------------
// Queue card types — after the grouping fold
// ---------------------------------------------------------------------------
type QueueCardSingle = {
  kind: "single";
  testRequestId: string;
  visitId: string;
  requestedAt: string;
  releasedAt: string | null;
  label: string;
  code: string;
  // Decides whether the list offers Claim — x-ray is x-ray-technician only.
  section: string | null;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
  canDelete: boolean;
};

type QueueCardGrouped = {
  kind: "grouped";
  visitId: string;
  groupId: string;
  groupCode: string;
  label: string;
  orderedTests: Array<{ code: string; name: string }>;
  requestedAt: string;
  releasedAt: string | null;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
  // All member test ids — the group deletes as one bulk action.
  memberIds: string[];
  // Only when EVERY member is deletable (a package component in the panel
  // makes the whole group non-deletable; the package deletes from the visit).
  canDelete: boolean;
};

type QueueCard = QueueCardSingle | QueueCardGrouped;

function statusRank(s: string): number {
  return s === "requested" ? 0 : s === "in_progress" ? 1 : 2;
}

export const metadata = {
  title: "Queue",
};

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
};

type QueueFilter = "mine" | "all" | "unclaimed" | "pending_release" | "released_today";

// Rows per page. The queue is a live worklist that rarely fills one page, so
// the pager stays hidden day to day — but the date filter can reach back into a
// busy past day, and a hard cap there silently truncated the list. One size for
// every tab, so switching tabs doesn't resize the page under you.
const PAGE_SIZE = 100;

const BASE_PATH = "/staff/queue";

/**
 * Sortable columns. `parseSort` requires this exact allow-list — the value
 * reaches a PostgREST `.order()`, so it is a security boundary.
 *
 * Patient is absent for the same reason as on the sibling results archive: it
 * lives two embeds down (`test_requests` → `visits` → `patients`), and only
 * a one-level embedded path is documented to reorder the parent rows. Test is
 * absent because a consolidated chemistry card folds several services into
 * one row, so it has no single service to order by.
 */
const SORTABLE_COLUMNS = ["requested_at", "released_at", "status", "visit_number"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/** The real column (or embedded path) each sort key orders by. */
const ORDER_COLUMN: Record<SortColumn, string> = {
  requested_at: "requested_at",
  released_at: "released_at",
  status: "status",
  // Needs `visits!inner`, which the select already has.
  visit_number: "visits(visit_number)",
};

// A test still on the bench has no `released_at`. Sink those to the bottom
// either way rather than opening on a screenful of blanks.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["released_at"]);

/** Everything a free-text search should be able to hit on one queue card. */
function cardHaystack(card: QueueCard): string {
  const tests =
    card.kind === "grouped"
      ? `${card.groupCode} ${card.orderedTests.map((t) => `${t.code} ${t.name}`).join(" ")}`
      : card.code;
  return `${card.patientName} ${card.patientDrmId} ${card.visitNumber} ${card.label} ${tests}`;
}

interface SearchProps {
  searchParams: Promise<{
    filter?: QueueFilter;
    // Orthogonal "only my claims" narrowing, ANDed onto whatever tab is
    // showing. Deliberately NOT a QueueFilter value: `filter=mine` is its
    // own tab (the worklist), while this narrows any tab — the lab
    // dashboard's "Released today (mine)" card needs
    // ?filter=released_today&mine=1, which no single enum value can express.
    mine?: string;
    start?: string;
    end?: string;
    q?: string;
    visit?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function QueuePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const filter = params.filter ?? "all";
  const mineOnly = params.mine === "1";
  const start = isISODate(params.start) ? params.start : "";
  const end = isISODate(params.end) ? params.end : "";
  const q = params.q?.trim() ?? "";
  const visit = params.visit?.trim() ?? "";
  const todayISO = todayManilaISODate();

  const session = await requireActiveStaff();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Each role sees only the sections it operates on. medtech doesn't see
  // imaging_xray (handled by xray_technician), and vice versa. admin /
  // pathologist see everything.
  const allowedSections = sectionsForRole(session.role);

  // "Released today" is a record of work that LEFT the bench; every other tab
  // is a worklist of work still on it. That split decides the date column, the
  // default order and which timestamp the first column shows.
  const releasedTab = filter === "released_today";
  const dateColumn: SortColumn = releasedTab ? "released_at" : "requested_at";
  const hasDateRange = Boolean(start || end);

  // The default ORDER is per tab: "Released today" is a record and reads
  // newest-released first, every other tab is a worklist and reads
  // oldest-requested first — the oldest job is the next one to pick up. So
  // "is this the default sort?", which decides whether `sort`/`dir` appear in
  // the URL at all, has to be asked against the tab in hand.
  const defaultSort: SortSpec<SortColumn> = {
    key: dateColumn,
    dir: releasedTab ? "desc" : "asc",
  };
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, defaultSort);
  const size = parsePageSize(params.size, PAGE_SIZE);
  const page = parsePage(params.page);
  const [from, to] = rangeFor(page, size);

  let query = supabase
    .from("test_requests")
    .select(
      `
        id, status, requested_at, released_at, assigned_to, started_at, visit_id, parent_id,
        hmo_claim_items ( batch_voided ),
        services!inner ( id, code, name, turnaround_hours, section, report_group_id,
          report_groups ( code, name ) ),
        visits!inner (
          id, visit_number, payment_status,
          patients!inner ( id, drm_id, first_name, last_name )
        )
      `,
      { count: "exact" },
    )
    // Soft-deleted lines — and every line of a soft-deleted visit — are out
    // of the worklist (0125).
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .in(
      "status",
      filter === "pending_release"
        ? ["ready_for_release"]
        : filter === "released_today"
          ? ["released"]
          : ["requested", "in_progress"],
    )
    .eq("is_package_header", false)
    // This is the LAB bench worklist. `test_requests` doubles as the visit's
    // bill line, so consultations and procedures sit in it too (0090) — and
    // they are never worked here: reception completes them over the counter
    // with "Mark done", which writes `released` directly.
    //
    // The section gate below only excluded them BY ACCIDENT, and only for
    // some roles: doctor services carry a null `section`, which fails the
    // medtech/xray `services.section in (…)` test — but admin and pathologist
    // resolve to `null` (unrestricted), so no section filter ran for them at
    // all. A pending consultation therefore sat in the admin/pathologist
    // queue looking claimable, and on prod it was the ONLY row in it.
    // Filtering by kind is what makes "no doctor lines here" true for EVERY
    // role, independent of the section gate.
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
    .order(ORDER_COLUMN[sort.key], {
      ascending: sort.dir === "asc",
      ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
    })
    // Tie-break on id. A visit's tests are written in one transaction and
    // share a `requested_at` to the millisecond, and a whole tab shares one
    // `status` — without a total order `.range()` drops and repeats rows
    // between pages.
    .order("id", { ascending: true })
    .range(from, to);

  // Payment gate (item 10, decision 1): the worklist tabs hide every test of a
  // visit that's still waiting for payment — fully paid, waived, or HMO-billed
  // visits only. Applied in the query so paging counts stay honest. "Pending
  // release" and "Released today" are records of completed work, not claimable
  // work, so they stay ungated (release itself is trigger-enforced on payment).
  const worklistTab = filter === "all" || filter === "mine" || filter === "unclaimed";
  if (worklistTab) {
    query = query.or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" });
  }

  // The date filter acts on whichever timestamp the tab is about: when a test
  // was released on the "Released today" tab, when it was requested elsewhere.
  // Bounds are Manila calendar days — a naive `${date}T00:00:00` would be read
  // in the DB's UTC zone and shift every boundary by 8 hours.
  const { fromIso, toIso } = manilaRangeUtc(start, end);
  if (fromIso) query = query.gte(dateColumn, fromIso);
  if (toIso) query = query.lt(dateColumn, toIso);

  // "Released today" keeps its implicit day window only while no explicit range
  // is set — an explicit range is the staffer overriding the tab.
  if (releasedTab && !hasDateRange) {
    const { startIso, endIso } = manilaDayWindowUtc(0);
    query = query.gte("released_at", startIso).lt("released_at", endIso);
  }

  // Section gate per role. `[]` means "no access" (reception) — it has to force
  // an empty result set, not fall through unfiltered, which is how the sibling
  // /staff/results gate is written. Guarding only on `length > 0` skipped the
  // filter entirely and showed reception every section's worklist.
  if (allowedSections !== null) {
    if (allowedSections.length === 0) {
      // Force an empty result set without breaking the query shape.
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("services.section", allowedSections);
    }
  }

  if (filter === "mine" && user) {
    query = query.eq("assigned_to", user.id);
  }

  // Waiting for someone to pick up — the same predicate as the dashboards'
  // "Unclaimed" cards (requested/in_progress with nobody holding it), so a
  // card's number and the tab it opens agree.
  if (filter === "unclaimed") {
    query = query.is("assigned_to", null);
  }

  // Same predicate as the Mine tab, applied on top of ANY tab. Harmless to
  // double up when both are set — it is the identical equality filter.
  if (mineOnly && user) {
    query = query.eq("assigned_to", user.id);
  }

  // Visit # filters server-side on the embedded visit, so it finds a test even
  // when the unfiltered queue would have run past the row cap before reaching it.
  const visitFilter = visitNumberFilter(visit);
  if (visitFilter?.kind === "exact") {
    query = query.in("visits.visit_number", visitFilter.values);
  } else if (visitFilter?.kind === "contains") {
    query = query.ilike("visits.visit_number", visitFilter.pattern);
  }

  const { data: rows, count } = await query;
  const queueTitle = queueTitleForRole(session.role);

  // -------------------------------------------------------------------------
  // Fold chemistry rows by (visit_id, report_group_id). Non-grouped rows
  // stay as single cards; grouped rows collapse to one card per group.
  //
  // `cards` keeps the QUERY's order: a grouped card is pushed when its FIRST
  // member is seen and mutated in place afterwards, so it sits exactly where
  // that member sat. Appending the grouped cards at the end instead — which
  // is what this did — lost the order and needed a re-sort by `requestedAt`
  // to recover it, and that re-sort silently undid any other column sort.
  // -------------------------------------------------------------------------
  const cards: QueueCard[] = [];
  const groupedAcc = new Map<string, QueueCardGrouped>();

  for (const r of rows ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    if (!svc || !visit) continue;
    const patient = Array.isArray(visit.patients)
      ? visit.patients[0]
      : visit.patients;
    if (!patient) continue;

    const patientName = `${patient.last_name}, ${patient.first_name}`;
    const rg = Array.isArray(svc.report_groups)
      ? svc.report_groups[0]
      : svc.report_groups;

    // Decision 6: reception + admin, unpaid visits, no released result, and
    // package components only via their header (from the visit page). The
    // query already excluded soft-deleted rows/visits.
    const rowDeletable = testDeletability(session.role, {
      status: r.status,
      deleted_at: null,
      parent_id: r.parent_id,
      visit_payment_status: visit.payment_status,
      visit_deleted_at: null,
      has_open_hmo_claim: hasOpenHmoClaim(r.hmo_claim_items),
    }).ok;

    if (svc.report_group_id && rg) {
      const key = `${r.visit_id}|${svc.report_group_id}`;
      const existing = groupedAcc.get(key);
      const test = { code: svc.code, name: svc.name };
      if (existing) {
        existing.orderedTests.push(test);
        existing.memberIds.push(r.id);
        existing.canDelete = existing.canDelete && rowDeletable;
        existing.label = `${rg.name} (${existing.orderedTests.length} tests)`;
        if (statusRank(r.status) < statusRank(existing.status)) {
          existing.status = r.status;
        }
        // Treat the card as unclaimed if any member is unclaimed.
        if (!r.assigned_to) existing.claimedBy = null;
        // Keep earliest requested_at for display, latest released_at — the
        // group isn't fully released until its last member is.
        if (r.requested_at < existing.requestedAt) {
          existing.requestedAt = r.requested_at;
        }
        if (r.released_at && (!existing.releasedAt || r.released_at > existing.releasedAt)) {
          existing.releasedAt = r.released_at;
        }
      } else {
        const created: QueueCardGrouped = {
          kind: "grouped",
          visitId: r.visit_id,
          groupId: svc.report_group_id,
          groupCode: rg.code,
          label: `${rg.name} (1 test)`,
          orderedTests: [test],
          requestedAt: r.requested_at,
          releasedAt: r.released_at,
          visitNumber: visit.visit_number,
          patientName,
          patientDrmId: patient.drm_id,
          status: r.status,
          claimedBy: r.assigned_to,
          href: `/staff/queue/consolidated/${r.visit_id}/${svc.report_group_id}`,
          memberIds: [r.id],
          canDelete: rowDeletable,
        };
        groupedAcc.set(key, created);
        cards.push(created);
      }
    } else {
      cards.push({
        kind: "single",
        testRequestId: r.id,
        visitId: r.visit_id,
        requestedAt: r.requested_at,
        releasedAt: r.released_at,
        label: svc.name,
        code: svc.code,
        section: svc.section,
        visitNumber: visit.visit_number,
        patientName,
        patientDrmId: patient.drm_id,
        status: r.status,
        claimedBy: r.assigned_to,
        href: `/staff/queue/${r.id}`,
        canDelete: rowDeletable,
      });
    }
  }

  // Free-text search runs after the fold, not in the query: an ILIKE across the
  // patients join is awkward in PostgREST (the same reason /staff/results
  // post-filters), and folding first lets one typed test code match the whole
  // consolidated chemistry card it belongs to.
  const matched = q
    ? cards.filter((c) => matchesAllTokens(cardHaystack(c), q))
    : cards;

  // Admins see who holds each in-progress claim so stuck claims are visible
  // straight from the list (Unclaim is on the row; reassign lives on the
  // detail page).
  const claimerNames = new Map<string, string>();
  if (session.role === "admin") {
    const claimerIds = Array.from(
      new Set(matched.map((c) => c.claimedBy).filter((v): v is string => !!v)),
    );
    if (claimerIds.length > 0) {
      const { data: claimers } = await supabase
        .from("staff_profiles")
        .select("id, full_name")
        .in("id", claimerIds);
      for (const p of claimers ?? []) claimerNames.set(p.id, p.full_name);
    }
  }
  // Remarks column: each test's claim history (claimed / unclaimed / reassigned)
  // from the audit log, via the queue_claim_remarks reader (0160) — audit_log
  // itself is admin-only, and the technicians are who need to see it. One call
  // for the whole page (≤ 100 rows; the function caps at 200).
  const pageTestIds = (rows ?? []).map((r) => r.id);
  const remarksByTest = await fetchClaimEvents(supabase, pageTestIds);
  const cardRemarks = (card: QueueCard) =>
    claimRemarks(
      (card.kind === "grouped" ? card.memberIds : [card.testRequestId]).flatMap(
        (id): ClaimEvent[] => remarksByTest.get(id) ?? [],
      ),
    );

  // Unclaim from the list: the holder may hand back their own claim, an admin
  // anyone's (the detail page's ReassignPanel power). A result already
  // uploaded moves the status on, so "in_progress" is the whole window. The
  // server action re-proves every part of this.
  const canUnclaim = (card: QueueCard) =>
    card.status === "in_progress" &&
    card.claimedBy !== null &&
    (session.role === "admin" || card.claimedBy === user?.id);

  // `q` is applied after the fetch, so it can only narrow the page in hand —
  // everything else is a real DB filter and counts against the whole table.
  const hasServerFilters = hasDateRange || Boolean(visit);
  const hasFilters = hasServerFilters || Boolean(q);
  // A range that ends before today can't gain rows, so live refreshes would
  // only interrupt someone reading history. An open-ended `start` still runs up
  // to now, so that stays live.
  const viewingHistory = Boolean(end) && end < todayISO;

  // Paging counts test_request rows (pre-fold), which is what the range applies
  // to — a page of rows can fold into fewer chemistry cards.
  const total = count ?? 0;
  const totalPages = pageCount(total, size);
  const safePage = Math.min(page, totalPages);

  // Params at their default are omitted, so the All tab on page 1 stays the
  // bare /staff/queue URL.
  const isDefaultSort = sort.key === defaultSort.key && sort.dir === defaultSort.dir;
  const baseParams: Record<string, string | null> = {
    filter: filter === "all" ? null : filter,
    mine: mineOnly ? "1" : null,
    start,
    end,
    q,
    visit,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZE ? null : String(size),
    page: page > 1 ? String(page) : null,
  };

  function buildHref(overrides: Record<string, string | null>): string {
    return buildListHref(BASE_PATH, baseParams, overrides);
  }

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === defaultSort.key && next.dir === defaultSort.dir;
    // A re-sort goes back to page 1 — page 3 of a worklist that just
    // reordered is a screenful of unrelated tests.
    return buildHref({
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string, align?: "left" | "right") => (
    <SortableTh
      key={key}
      label={label}
      href={sortHref(key)}
      state={ariaSortFor(sort, key)}
      align={align}
    />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      {viewingHistory ? null : (
        <RealtimeRefresher
          channelName="queue-page"
          subscriptions={LAB_QUEUE_SUBSCRIPTIONS}
        />
      )}
      <PageHeader
        title={queueTitle}
        subtitle={
          <>
            Tests requested or in progress, oldest first.
            {worklistTab
              ? " Visits waiting for payment appear once they're paid or HMO-covered."
              : null}
            {hasServerFilters ? ` · ${total} matching` : null}
            {q ? ` · ${matched.length} on this page match “${q}”` : null}
            {filter === "released_today" && hasDateRange
              ? " · showing the dates you picked, not just today"
              : null}
            {mineOnly ? " · only tests claimed by you" : null}
          </>
        }
      />

      {/* The tab bar lives BELOW the header, not in its `actions` slot. In the
          slot it shared a `flex-wrap justify-between` row with the title +
          subtitle — and this page's subtitle changes length on every tab
          ("N matching", "showing the dates you picked", the worklist
          sentence). A longer subtitle pushed the bar to a new line and a
          shorter one pulled it back up beside the title, so the tabs visibly
          jumped between positions each time one was clicked. Standalone, they
          sit in the same place no matter what the subtitle says — and this is
          the shared tab-bar treatment every other staff section page uses
          (visits/queue, appointments, patient-ar). */}
      <nav className={sectionTabsNavClass} aria-label="Queue filter">
        <FilterTab
          href={buildHref({ filter: null, page: null })}
          label="All"
          active={filter === "all"}
        />
        <FilterTab
          href={buildHref({ filter: "unclaimed", page: null })}
          label="Unclaimed"
          active={filter === "unclaimed"}
        />
        <FilterTab
          href={buildHref({ filter: "pending_release", page: null })}
          label="Pending release"
          active={filter === "pending_release"}
        />
        <FilterTab
          href={buildHref({ filter: "released_today", page: null })}
          label="Released today"
          active={filter === "released_today"}
        />
        <FilterTab
          href={buildHref({ filter: "mine", page: null })}
          label="Mine"
          active={filter === "mine"}
        />
      </nav>

      {/* "Only mine" narrows whichever tab is open. It sits below the tab bar
          for the same reason the tabs are not in the header's actions slot —
          this page's subtitle changes length on every tab, so anything sharing
          that row visibly jumps. The Mine tab already IS mine, so the toggle
          would be a no-op there — and on Unclaimed it could only ever empty
          the list. */}
      {filter !== "mine" && filter !== "unclaimed" ? (
        <div className="mb-4">
          <Link
            href={buildHref({ mine: mineOnly ? null : "1", page: null })}
            aria-pressed={mineOnly}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              mineOnly
                ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)]/10 text-[color:var(--color-brand-navy)]"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)]"
            }`}
          >
            {mineOnly ? "✓ Only tests claimed by me" : "Only tests claimed by me"}
          </Link>
        </div>
      ) : null}

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        action="/staff/queue"
      >
        {/* Keep the open tab when filters are applied. */}
        <input type="hidden" name="filter" value={filter === "all" ? "" : filter} />
        {/* A plain-GET form submits only the fields it carries, so without
            this the "Only tests claimed by me" toggle silently resets the
            moment someone applies a date or search filter. */}
        <input type="hidden" name="mine" value={mineOnly ? "1" : ""} />
        {/* A GET form submits only the fields it carries, so without these
            Apply would silently reset the reader's sort and page size. */}
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === PAGE_SIZE ? null : (
          <input type="hidden" name="size" value={String(size)} />
        )}
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            {filter === "released_today" ? "Released from" : "Requested from"}
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            …to
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="q"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Patient / test search
          </label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. Castillo, CBC, DRM-0123"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="visit"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Visit #
          </label>
          <input
            type="text"
            id="visit"
            name="visit"
            defaultValue={visit}
            inputMode="numeric"
            placeholder="e.g. 37 or 0037"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-full flex flex-wrap gap-2">
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Apply
          </button>
          {hasFilters ? (
            <Link
              href={buildHref({
                start: null,
                end: null,
                q: null,
                visit: null,
                page: null,
              })}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      {viewingHistory ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          You&apos;re looking at past dates, not the live queue. Rows here
          don&apos;t refresh on their own.
        </p>
      ) : null}

      {/* The search box filters the fetched page, so say so rather than let a
          page-1 miss read as "not in the queue". */}
      {q && totalPages > 1 ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          The search box only looks at the {size} tests on this page. Narrow
          the dates or use Visit # to search the whole queue.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {/* "Released today" is about when work LEFT the bench, and the
                  tab has always ordered by `released_at` — but the column was
                  labelled "Requested" and printed the request time, so the
                  order it was in matched nothing on screen. On that tab the
                  column now shows, and sorts by, the release time. */}
              {releasedTab
                ? th("released_at", "Released")
                : th("requested_at", "Requested")}
              {/* Patient and Test can't be ordered — see SORTABLE_COLUMNS. */}
              <PlainTh label="Patient" />
              {th("visit_number", "Visit")}
              <PlainTh label="Test" />
              {th("status", "Status")}
              <PlainTh label="Action" align="right" />
              <PlainTh label="Remarks" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {matched.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {hasFilters
                    ? "No queued tests match these filters."
                    : filter === "unclaimed"
                      ? "Nothing is waiting to be picked up."
                      : "Queue is empty."}
                </td>
              </tr>
            ) : (
              matched.map((card) => {
                if (card.kind === "single") {
                  return (
                    <tr
                      key={card.testRequestId}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        {manilaDateTime(releasedTab ? card.releasedAt : card.requestedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={card.href}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {card.patientName}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {card.patientDrmId}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${card.visitId}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{card.visitNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {card.label}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {card.code}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            TEST_STATUS_STYLE[card.status] ?? ""
                          }`}
                        >
                          {card.status.replace(/_/g, " ")}
                        </span>
                        {card.claimedBy && claimerNames.has(card.claimedBy) ? (
                          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                            Claimed by {claimerNames.get(card.claimedBy)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {card.status === "requested" &&
                        canClaimSection(session.role, card.section) ? (
                          <ClaimButton
                            testRequestId={card.testRequestId}
                            navigateOnClaim
                          />
                        ) : (
                          <>
                            <Link
                              href={card.href}
                              className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                            >
                              Open →
                            </Link>
                            {card.status === "requested" ? (
                              <ClaimOwnerHint section={card.section} />
                            ) : null}
                          </>
                        )}
                        {canUnclaim(card) ? (
                          <div className="mt-1 flex justify-end">
                            <QueueUnclaimButton
                              testRequestIds={[card.testRequestId]}
                              entryLabel={card.label}
                            />
                          </div>
                        ) : null}
                        {card.canDelete ? (
                          <div className="mt-1.5 flex justify-end">
                            <QueueDeleteDialog
                              visitId={card.visitId}
                              testRequestIds={[card.testRequestId]}
                              mode="delete"
                              entryLabel={card.label}
                            />
                          </div>
                        ) : null}
                      </td>
                      <RemarksCell remarks={cardRemarks(card)} />
                    </tr>
                  );
                }

                // Grouped card (chemistry consolidated report)
                return (
                  <tr
                    key={`${card.visitId}|${card.groupId}`}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manilaDateTime(releasedTab ? card.releasedAt : card.requestedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={card.href}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {card.patientName}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {card.patientDrmId}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/visits/${card.visitId}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        #{card.visitNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {card.label}
                      </p>
                      <div className="flex max-w-md flex-wrap items-baseline gap-x-1.5 gap-y-1 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        <span>{card.groupCode} ·</span>
                        {card.orderedTests.map((t) => (
                          <span key={t.code}>{t.code}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[card.status] ?? ""
                        }`}
                      >
                        {card.status.replace(/_/g, " ")}
                      </span>
                      {card.claimedBy && claimerNames.has(card.claimedBy) ? (
                        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                          Claimed by {claimerNames.get(card.claimedBy)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={card.href}
                        className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open →
                      </Link>
                      {canUnclaim(card) ? (
                        <div className="mt-1 flex justify-end">
                          <QueueUnclaimButton
                            testRequestIds={card.memberIds}
                            entryLabel={card.label}
                          />
                        </div>
                      ) : null}
                      {card.canDelete ? (
                        <div className="mt-1.5 flex justify-end">
                          <QueueDeleteDialog
                            visitId={card.visitId}
                            testRequestIds={card.memberIds}
                            mode="delete"
                            entryLabel={card.label}
                          />
                        </div>
                      ) : null}
                    </td>
                    <RemarksCell remarks={cardRemarks(card)} />
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      {/* The pager counts TESTS, which is what `.range()` slices; a
          consolidated chemistry card folds several of them into one row. */}
      <ListPagination
        page={safePage}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          safePage > 1
            ? buildHref({ page: safePage > 2 ? String(safePage - 1) : null })
            : null
        }
        nextHref={safePage < totalPages ? buildHref({ page: String(safePage + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((n) => ({
          size: n,
          // Resizing resets to page 1 — same reasoning as a re-sort.
          href: buildHref({
            size: n === PAGE_SIZE ? null : String(n),
            page: null,
          }),
        }))}
        noun="test"
      />
    </div>
  );
}

// Where a Claim button would be, for a test only another role may claim
// (x-ray → X-ray technician). Says why instead of silently offering nothing.
function ClaimOwnerHint({ section }: { section: string | null }) {
  const owner = claimOwnerRole(section);
  if (!owner) return null;
  return (
    <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
      {claimOwnerLabel(owner)} only
    </p>
  );
}

function RemarksCell({ remarks }: { remarks: ReturnType<typeof claimRemarks> }) {
  if (remarks.length === 0) {
    return (
      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
        —
      </td>
    );
  }
  return (
    <td className="min-w-48 max-w-xs px-4 py-3 text-xs">
      <ClaimRemarksList remarks={remarks} max={MAX_REMARKS_SHOWN} />
    </td>
  );
}

function FilterTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={sectionTabClass(active)}
      // Every sibling tab bar marks its selected tab this way (SectionTabs,
      // visits, visits/queue, appointments, patient-ar); this one did not, so
      // a screen reader announced four ordinary links with nothing to say
      // which was open.
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
