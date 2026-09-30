import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { claimRemarks, MAX_REMARKS_SHOWN } from "@/lib/queue/claim-remarks";
import { fetchClaimEvents } from "@/lib/queue/fetch-claim-events";
import { ClaimRemarksList } from "@/components/staff/claim-remarks-list";
import {
  isISODate,
  manilaDateTime,
  manilaRangeUtc,
  todayManilaISODate,
} from "@/lib/dates/manila";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { applyLabSearch, labSearchPatterns } from "@/lib/queue/lab-search";
import { PageHeader } from "@/components/staff/page-header";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { DOCTOR_KIND_VALUES } from "@/lib/visits/classification";
import {
  RESULT_STATUSES,
  RESULT_STATUS_LABEL,
  parseResultStatusFilter,
  resultStatusSpec,
  testStatusLabel,
  type ResultStatusFilter,
} from "@/lib/results/status-filter";
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
import {
  foldArchiveRows,
  reportMembershipOnPage,
  type ArchiveItem,
  type ArchiveResultLink,
  type ArchiveTestRow,
  type MembershipDisplay,
} from "@/lib/results/archive-fold";
import { codeDuplicatesName } from "@/lib/results/consolidated-reports";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import { fetchCompleteRowsByIds } from "@/lib/reports/paging";
import { fetchPrintState } from "@/lib/results/print-history";
import {
  parseUpdatedFilter,
  updatedSinceIso,
  UPDATED_FILTER_LABEL,
  type UpdatedFilter,
} from "@/lib/results/updated-filter";
import { resultsMemberSections, membersWithinSections } from "@/lib/results/report-section-gate";
import { InactivePatientBadge } from "@/components/staff/inactive-patient-badge";
import { isActivePatient } from "@/lib/patients/active";

export const metadata = { title: "Results" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/results";

/** This archive has always shown 50 rows; the picker can change it. */
const DEFAULT_SIZE = 50;

/**
 * Sortable columns. `parseSort` requires this exact allow-list — the value
 * reaches a PostgREST `.order()`, so it is a security boundary.
 *
 * Patient is NOT here. It lives two embeds down (`test_requests` → `visits`
 * → `patients`), and the embedded-path form that reorders parent rows —
 * `.order("patients(last_name)")`, see the Visits archive — is only
 * documented one level deep. Visit # is one level (`visits`), which is why it
 * can be sorted and Patient can't.
 *
 * Tests and PDF are per-row lists folded from several `test_requests`, so
 * they have no single value to order by at all.
 */
const SORTABLE_COLUMNS = [
  "requested_at",
  "completed_at",
  "released_at",
  "status",
  "visit_number",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/** The real column (or embedded path) each sort key orders by. */
const ORDER_COLUMN: Record<SortColumn, string> = {
  requested_at: "requested_at",
  completed_at: "completed_at",
  released_at: "released_at",
  status: "status",
  // Needs `visits!inner`, which the select already has.
  visit_number: "visits(visit_number)",
};

// A test that hasn't been completed or released yet renders "—". Sink those
// to the bottom either way, so ordering by Released doesn't just surface
// every unfinished test first.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["completed_at", "released_at"]);

const STATUS_BADGE: Record<string, string> = {
  released: "bg-emerald-50 text-emerald-700 border-emerald-200",
  result_uploaded: "bg-sky-50 text-sky-700 border-sky-200",
  ready_for_release: "bg-sky-50 text-sky-700 border-sky-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  requested: "bg-slate-50 text-slate-700 border-slate-200",
  cancelled: "bg-red-50 text-red-700 border-red-200",
};

// The archive's main select, in three literal shapes rather than one
// interpolated with `${…}`. query-surfaces.test.ts statically proves every
// test_requests chain that filters visits.deleted_at also embeds
// visits!inner, by reading the literal text passed to .select() in the same
// call chain (CLAUDE.md: PostgREST silently ignores a filter on a
// LEFT-joined embed) — it can resolve a plain string/template-literal
// constant referenced by name, even from inside a ternary, but not a
// template built with a substitution, so each shape below is spelled out in
// full rather than composed from a shared fragment.
const ARCHIVE_SELECT_BASE = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) )
`;

// "Updated · last 7 days" (?updated=7d): adds an inner embed down to
// results.amended_at, which every result_edit_commit stamps to now() — the
// latest correction's own timestamp, so no result_amendments read is
// needed. Only added while this filter is active: an unconditional !inner
// here would turn the plain select into an inner join and silently drop
// every test whose result was never corrected.
const ARCHIVE_SELECT_UPDATED_7D = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) ),
  result_test_requests!inner ( results!inner ( amended_at ) )
`;

// "Updated by me" (?updated=mine): nested two levels under `results`, not
// test_requests directly, because result_edit_commit only stamps
// result_amendments.test_request_id with the ANCHOR member of a
// consolidated report (p_anchor_test_request_id, 0172) — filtering via the
// embedded result_id instead catches every sibling member of the report,
// matching what the old id-list version did.
const ARCHIVE_SELECT_UPDATED_MINE = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) ),
  result_test_requests!inner ( results!inner ( result_amendments!inner ( amended_by ) ) )
`;

// The same three shapes plus the search embed (migration 0194, `lab_search!inner
// ( )`), used only while there are search words: an unconditional inner join
// would run the search view on every archive load. Spelled out in full for the
// same reason as above — query-surfaces.test.ts must be able to read every
// branch of the ternary that picks between them.
const ARCHIVE_SELECT_BASE_SEARCH = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) ),
  lab_search!inner ( )`;

const ARCHIVE_SELECT_UPDATED_7D_SEARCH = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) ),
  result_test_requests!inner ( results!inner ( amended_at ) ),
  lab_search!inner ( )`;

const ARCHIVE_SELECT_UPDATED_MINE_SEARCH = `
  id, status, released_at, completed_at, requested_at,
  visits!inner ( id, visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id, deleted_at, merged_into_id ) ),
  services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) ),
  result_test_requests!inner ( results!inner ( result_amendments!inner ( amended_by ) ) ),
  lab_search!inner ( )`;


interface SearchProps {
  searchParams: Promise<{
    status?: string;
    start?: string;
    end?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
    updated?: string;
  }>;
}

interface ResultRow {
  id: string;
  status: string;
  released_at: string | null;
  completed_at: string | null;
  requested_at: string;
  visits: {
    id: string;
    visit_number: string;
    payment_status: string;
    hmo_provider_id: string | null;
    patients: {
      first_name: string;
      last_name: string;
      drm_id: string;
      deleted_at: string | null;
      merged_into_id: string | null;
    } | null;
  } | null;
  services: {
    code: string;
    name: string;
    kind: string;
    section: string | null;
    report_group_id: string | null;
    report_groups: { name: string } | { name: string }[] | null;
  } | null;
}

export default async function AllResultsPage({ searchParams }: SearchProps) {
  const staff = await requireActiveStaff();
  const allowedSections = sectionsForRole(staff.role); // null = unrestricted
  const sp = await searchParams;

  const status: ResultStatusFilter = parseResultStatusFilter(sp.status);
  const spec = resultStatusSpec(status);
  // The default ORDER is per tab: Unclaimed is a worklist and reads
  // oldest-first, every other tab is a record and reads newest-first. So
  // "is this the default sort?" — which decides whether `sort`/`dir` appear
  // in the URL at all — has to be asked against the tab in hand.
  const defaultSort: SortSpec<SortColumn> = {
    key: "requested_at",
    dir: spec?.oldestFirst === true ? "asc" : "desc",
  };
  const sort = parseSort(sp.sort, sp.dir, SORTABLE_COLUMNS, defaultSort);
  const size = parsePageSize(sp.size, DEFAULT_SIZE);
  const page = parsePage(sp.page);
  const [from, to] = rangeFor(page, size);
  const todayISO = todayManilaISODate();
  const start = isISODate(sp.start) ? sp.start : "";
  const end = isISODate(sp.end) ? sp.end : "";
  const q = sp.q?.trim() ?? "";
  const searchPatterns = labSearchPatterns(q);
  const searching = searchPatterns.length > 0;

  const admin = createAdminClient();
  // The Updated column further down still reads result_amendments through
  // the signed-in client (RLS-scoped reasons).
  const staffDb = await createClient();

  // "Updated" filter (?updated=7d|mine) — narrows the archive to tests whose
  // result was corrected recently, or by the signed-in staff member. Applied
  // as a database-side filter via a PostgREST embedded !inner join on the
  // main query itself — never a post-fetch id list (CLAUDE.md: a filter
  // applied after the fetch breaks count:"exact" + .range() paging) and
  // never an inlined uuid array (the old shape read up to 1000
  // result_amendments rows, then inlined their linked test ids into
  // `.in("id", …)` — a URL up to ~37KB, and itself silently capped at 1000
  // corrections).
  //
  // 7d: `results.amended_at` is stamped to now() by every result_edit_commit
  // (0172, redefined by 0179) — it already IS the latest correction's
  // timestamp, so no result_amendments read is needed at all. "Latest
  // correction within 7 days" and "any correction within 7 days" are the
  // same test, since the latest correction time is >= every earlier one.
  //
  // mine: nested two levels under `results`, not test_requests directly,
  // because result_edit_commit only stamps result_amendments.test_request_id
  // with the ANCHOR member of a consolidated report (p_anchor_test_request_id,
  // 0172) — filtering via the embedded result_id instead catches every
  // sibling member, matching what the old id-list version did. This runs on
  // the service-role client, so `amended_by = me` isn't RLS-enforced here —
  // the archive's own section gating (below) already scopes which rows this
  // role can see at all.
  //
  // Both embeds are added to the select ONLY while their filter is active:
  // CLAUDE.md — an unconditional !inner would turn the plain select into an
  // inner join and silently drop every test whose result was never
  // corrected.
  const updated: UpdatedFilter | null = parseUpdatedFilter(sp.updated);

  let query = admin
    .from("test_requests")
    .select(
      // Six literal select shapes (three filters x with/without the search
      // embed), chosen by plain ternaries rather than `${…}` interpolation:
      // query-surfaces.test.ts statically proves every test_requests chain that
      // filters visits.deleted_at embeds visits!inner (CLAUDE.md — PostgREST
      // silently ignores a filter on a LEFT-joined embed), and it can only read
      // a literal/no-substitution template argument, not a computed string.
      updated === "7d"
        ? searching
          ? ARCHIVE_SELECT_UPDATED_7D_SEARCH
          : ARCHIVE_SELECT_UPDATED_7D
        : updated === "mine"
          ? searching
            ? ARCHIVE_SELECT_UPDATED_MINE_SEARCH
            : ARCHIVE_SELECT_UPDATED_MINE
          : searching
            ? ARCHIVE_SELECT_BASE_SEARCH
            : ARCHIVE_SELECT_BASE,
      { count: "exact" },
    )
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order(ORDER_COLUMN[sort.key], {
      ascending: sort.dir === "asc",
      ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
    })
    // Tie-break on id. Every column here ties heavily — a visit's tests share
    // a `requested_at` to the millisecond, and a whole tab shares one
    // `status` — so without a total order `.range()` drops and repeats rows
    // between pages, which on a folded table shows up as a visit appearing
    // twice or not at all.
    .order("id", { ascending: true })
    .range(from, to);

  if (spec) {
    query = query.in("status", spec.statuses);
    // Unclaimed and In progress cover the same statuses and are told apart by
    // who holds the test — see lib/results/status-filter.ts.
    if (spec.assignee === "unclaimed") {
      query = query.is("assigned_to", null);
    } else if (spec.assignee === "claimed") {
      query = query.not("assigned_to", "is", null);
    }
  }
  // Manila calendar days, half-open. The old naive `${start}T00:00:00` bounds
  // carried no offset, so Postgres read them in the server's UTC zone and every
  // boundary landed 8 hours early — a test requested at 07:00 Manila fell into
  // the previous day, and `T23:59:59` dropped the last second outright.
  const { fromIso, toIso } = manilaRangeUtc(start, end);
  if (fromIso) query = query.gte("requested_at", fromIso);
  if (toIso) query = query.lt("requested_at", toIso);

  // Doctor lines are not results. `test_requests` doubles as the visit's bill
  // line, so a consultation (and a procedure) is stored in it too — but it goes
  // straight from `requested` to `released` at the counter with no bench step,
  // no `results` row and no PDF, so every one of them landed here as a row whose
  // Status said "released" and whose PDF cell said "—". They outnumbered the lab
  // work: 7.4k of the 25.6k live lines, and because a split encounter files the
  // doctor half as its own visit (0090), 7,350 of 14,259 visit rows on this page
  // were consultation-only — more than half the archive, pushing real lab work
  // off the first page.
  //
  // Enumerating the doctor kinds rather than allow-listing the lab ones is the
  // same complement rule as `classifyKind()`, so a kind seeded into the catalog
  // later still shows up here instead of silently vanishing from the archive.
  // Consultations keep their home on /staff/visits under the "Doctor Consults"
  // chip, which is the surface built to show them.
  query = query.not("services.kind", "in", `(${DOCTOR_KIND_VALUES.join(",")})`);

  // Section gate per role: admin + pathologist see everything (null), medtech
  // sees lab-bench sections, xray sees imaging sections, reception sees nothing.
  // (Non-admin roles never saw the doctor lines anyway — `CONSULT` carries a
  // null section, which no role's list matches — so this only ever showed for
  // admin and pathologist, whose `null` list skips the filter entirely.)
  if (allowedSections !== null) {
    if (allowedSections.length === 0) {
      // Force empty result set without breaking the query shape.
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("services.section", allowedSections);
    }
  }

  // Free-text search is a real filter like the rest: every word must match the
  // row's patient / visit # / test / panel text (migration 0194), so `total`
  // and the pager count the searched set, not just the page in hand.
  query = applyLabSearch(query, searchPatterns);

  if (updated === "7d") {
    query = query.gte("result_test_requests.results.amended_at", updatedSinceIso());
  } else if (updated === "mine") {
    query = query.eq("result_test_requests.results.result_amendments.amended_by", staff.user_id);
  }

  const { data, count, error: updatedFilterError } = await query.returns<ResultRow[]>();
  const rows = data ?? [];

  // Which result each test_request links to — junction → results. A
  // consolidated (chemistry) report is ONE results row shared by every member
  // test, so the fold below keys PDFs and edit markers by result, not by test.
  // One query for the visible page, keyed by test_request_id.
  const trIds = rows.map((r) => r.id);
  const linkByTrId = new Map<string, ArchiveResultLink>();
  if (trIds.length > 0) {
    const { data: links } = await admin
      .from("result_test_requests")
      .select("test_request_id, result_id, results!inner ( storage_path, amended_at, amendment_count )")
      .in("test_request_id", trIds);
    for (const link of links ?? []) {
      const res = Array.isArray(link.results) ? link.results[0] : link.results;
      if (!res) continue;
      linkByTrId.set(link.test_request_id, {
        resultId: link.result_id,
        hasPdf: Boolean(res.storage_path),
        amendedAt: res.amended_at,
        amendmentCount: res.amendment_count,
      });
    }
  }

  // Full live membership per finished result, for the fold label. The base
  // query above paginates test_requests BEFORE the fold, so a report can
  // straddle a page boundary or lose a sibling to the date/search filters —
  // "Chemistry (8 tests)" on this page must count the report's REAL size, not
  // just what happened to land on this page. One batched junction query, keyed
  // by every finished result_id on the page, counting only LIVE members
  // (deleted_at is null on both the test and its visit) — the same predicate
  // the consolidated report-group page counts "N tests" by, so the two
  // surfaces never disagree about a report's size.
  //
  // At most `size` (≤100) result ids go in, but the members they return are
  // deliberately off-page too (a report with 19 tests showing one), so the
  // read is paged to completion with a total order (test_request_id is unique
  // on the junction) rather than trusting one request under PostgREST's
  // silent 1000-row cap.
  const finishedResultIds = Array.from(
    new Set(
      Array.from(linkByTrId.values())
        .filter((l) => l.hasPdf)
        .map((l) => l.resultId),
    ),
  );
  const fullMembershipByResultId = new Map<string, number>();
  if (finishedResultIds.length > 0) {
    const { data: memberRows } = await fetchCompleteRowsByIds(
      finishedResultIds,
      (ids, from, to) =>
        admin
          .from("result_test_requests")
          .select("result_id, test_request_id, test_requests!inner ( id, visits!inner ( id ) )")
          .in("result_id", ids)
          .is("test_requests.deleted_at", null)
          .is("test_requests.visits.deleted_at", null)
          .order("test_request_id", { ascending: true })
          .range(from, to),
    );
    for (const row of memberRows ?? []) {
      fullMembershipByResultId.set(
        row.result_id,
        (fullMembershipByResultId.get(row.result_id) ?? 0) + 1,
      );
    }
  }

  // The latest edit's reason per amended result, for the Updated column. Only
  // results on this page with amendment_count > 0, so this is empty on almost
  // every render and bounded by the page size when it isn't. Read through the
  // SIGNED-IN client, not `admin`: RLS on result_amendments (0172,
  // staff_can_read_finished_result) keeps the reason from a medtech whose
  // sections cover only part of a combined report — the date still shows.
  const amendedIds = Array.from(
    new Set(
      Array.from(linkByTrId.values())
        .filter((l) => l.amendmentCount > 0)
        .map((l) => l.resultId),
    ),
  );
  const lastEditReason = new Map<string, string>();
  if (amendedIds.length > 0) {
    const { data: amends } = await staffDb
      .from("result_amendments")
      .select("result_id, reason, amendment_seq")
      .in("result_id", amendedIds)
      .order("amendment_seq", { ascending: false });
    for (const am of amends ?? []) {
      if (!lastEditReason.has(am.result_id)) lastEditReason.set(am.result_id, am.reason);
    }
  }

  // Whether the latest print of a corrected result's file is an older
  // version than the one on file now — "Printed copy out of date" in the
  // Updated column. This archive has no Print button of its own, but the
  // counter may have printed the earlier version from the visit page.
  const printableFiles = Array.from(
    new Map(
      Array.from(linkByTrId.values())
        .filter((l) => l.hasPdf)
        .map((l) => [l.resultId, l]),
    ).values(),
  );
  const { stale: staleByResultId } = await fetchPrintState(
    printableFiles.map((l) => ({ resultId: l.resultId, version: l.amendmentCount })),
  );

  // Remarks column: each test's claim history, same reader and wording as the
  // lab queue. Called through the signed-in staff client, NOT `admin` above —
  // queue_claim_remarks gates on the caller's role, and the service role has
  // none, so it would answer empty.
  const claimEvents = await fetchClaimEvents(staffDb, trIds);
  const remarksFor = (testIds: string[]) =>
    claimRemarks(testIds.flatMap((id) => claimEvents.get(id) ?? []));

  // The fold works on plain rows; the lab-gate flag is per visit.
  const awaitingByVisit = new Map<string, boolean>();
  const archiveRows: ArchiveTestRow[] = [];
  for (const r of rows) {
    const visit = r.visits;
    if (!visit) continue;
    if (!awaitingByVisit.has(visit.id)) awaitingByVisit.set(visit.id, !labQueueGate(visit).ok);
    const grp = r.services?.report_groups;
    archiveRows.push({
      id: r.id,
      status: r.status,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      releasedAt: r.released_at,
      code: r.services?.code ?? "—",
      name: r.services?.name ?? "",
      reportGroupId: r.services?.report_group_id ?? null,
      reportGroupName: (Array.isArray(grp) ? grp[0]?.name : grp?.name) ?? null,
      visit: { id: visit.id, visitNumber: visit.visit_number, patient: visit.patients },
    });
  }

  const foldedRows = foldArchiveRows(archiveRows, linkByTrId, (r) => ({
    awaitingPayment: awaitingByVisit.get(r.visit.id) ?? false,
  }));

  // Every-member section check on the "PDF →" link (0179): a shared report
  // PDF still carries a deleted member's values, so the gate has to read
  // sections for EVERY linked test — deleted ones included — not just the
  // live members this page's query already returned. One batched read keyed
  // by every result on the page that has a PDF.
  const pdfResultIds = Array.from(
    new Set(
      foldedRows.flatMap((v) =>
        v.items
          .filter((item) => item.pdfTestRequestId !== null && item.resultId !== null)
          .map((item) => item.resultId!),
      ),
    ),
  );
  const memberSectionsByResultId =
    pdfResultIds.length > 0 ? await resultsMemberSections(admin, pdfResultIds) : new Map<string, (string | null)[]>();
  const canViewItemPdf = (item: ArchiveItem): boolean => {
    if (!item.pdfTestRequestId || !item.resultId) return false;
    return (
      memberSectionsByResultId !== null &&
      membersWithinSections(allowedSections, memberSectionsByResultId.get(item.resultId) ?? [])
    );
  };

  // One membership lookup per report item, shared by the label and the
  // caveat line below the table.
  const membershipFor = (item: ArchiveItem): MembershipDisplay =>
    reportMembershipOnPage({
      shown: item.tests.length,
      full: item.resultId ? fullMembershipByResultId.get(item.resultId) ?? item.tests.length : null,
    });
  const hasPartialReport = foldedRows.some((g) =>
    g.items.some((item) => item.kind === "report" && membershipFor(item).partial),
  );

  const total = count ?? 0;
  const totalPages = pageCount(total, size);
  const safePage = Math.min(page, totalPages);

  // Params at their default are omitted, so the All tab on page 1 stays the
  // bare /staff/results URL.
  const isDefaultSort = sort.key === defaultSort.key && sort.dir === defaultSort.dir;
  const baseParams: Record<string, string | null> = {
    status: status === "all" ? null : status,
    start,
    end,
    q,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_SIZE ? null : String(size),
    updated,
  };

  function buildHref(overrides: Record<string, string | null>): string {
    return buildListHref(BASE_PATH, baseParams, overrides);
  }

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === defaultSort.key && next.dir === defaultSort.dir;
    // A re-sort goes back to page 1 — page 7 of a set that just reordered is
    // a screenful of unrelated visits.
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

  const hasFilters = Boolean(start || end || searching || status !== "all" || updated);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Results"
        subtitle={
          <>
            Archive of every lab test — unclaimed, in progress, ready for
            release, released, or cancelled. Doctor consultations and procedures
            have no result to release, so they live on{" "}
            <Link href="/staff/visits?kind=consult" className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline">
              Visits
            </Link>
            .
            {hasFilters
              ? ` · ${total.toLocaleString("en-PH")} matching`
              : ` · ${total.toLocaleString("en-PH")} total`}
          </>
        }
      />

      <nav className="mb-4 flex flex-wrap gap-2">
        {RESULT_STATUSES.map((s) => {
          const active = s === status;
          return (
            <Link
              key={s}
              // Switching tab keeps the sort, the dates and the search — the
              // same columns over a different status set — but goes back to
              // page 1.
              href={buildHref({ status: s === "all" ? null : s, page: null })}
              className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {RESULT_STATUS_LABEL[s]}
            </Link>
          );
        })}
      </nav>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Updated filter">
        {(Object.keys(UPDATED_FILTER_LABEL) as UpdatedFilter[]).map((key) => {
          const active = updated === key;
          return (
            <Link
              key={key}
              // Toggling an Updated chip keeps the sort, page size and status
              // tab — only the Updated filter and the page change.
              href={buildHref({ updated: active ? null : key, page: null })}
              aria-pressed={active}
              className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-violet-600"
              }`}
            >
              {UPDATED_FILTER_LABEL[key]}
            </Link>
          );
        })}
      </nav>

      {updated && updatedFilterError ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          Couldn&apos;t apply the Updated filter — try again in a moment.
        </p>
      ) : null}

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        action="/staff/results"
      >
        <input type="hidden" name="status" value={status === "all" ? "" : status} />
        {/* A GET form submits only the fields it carries, so without these
            Apply would silently reset the reader's sort and page size. */}
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === DEFAULT_SIZE ? null : (
          <input type="hidden" name="size" value={String(size)} />
        )}
        {/* Submitting Apply must not silently drop an active Updated chip. */}
        {updated ? <input type="hidden" name="updated" value={updated} /> : null}
        <div className="flex flex-col">
          <label htmlFor="start" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Requested from
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
          <label htmlFor="end" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
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
        <div className="flex flex-col sm:col-span-2">
          <label htmlFor="q" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Patient / service search
          </label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. Castillo, CBC, DRM-2024-0123"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-full flex flex-wrap gap-2">
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Apply
          </button>
          {hasFilters ? (
            <Link
              // Clears the FILTERS, not the view: sort and page size survive.
              href={buildHref({
                status: null,
                start: null,
                end: null,
                q: null,
                updated: null,
                page: null,
              })}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {status === "unclaimed" && !start && !end && !searching
              ? "Nothing is waiting to be picked up — every test in progress has someone on it."
              : "No results match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {/* Patient, Tests, Updated and PDF can't be ordered — see SORTABLE_COLUMNS. */}
                  <PlainTh label="Patient" />
                  <PlainTh label="Tests" />
                  {th("status", "Status")}
                  {th("requested_at", "Requested")}
                  {th("completed_at", "Completed")}
                  {th("released_at", "Released")}
                  <PlainTh label="Updated" />
                  <PlainTh label="PDF" />
                  <PlainTh label="Remarks" />
                  {th("visit_number", "Visit", "right")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {foldedRows.map((g) => {
                  const pat = g.patient;
                  const patientLabel = pat
                    ? `${pat.last_name}, ${pat.first_name}`
                    : "—";
                  const statusSummary = summarizeStatuses(g.statuses);
                  return (
                    <tr key={g.visitId} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patientLabel}
                        </div>
                        {pat ? (
                          <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {pat.drm_id}
                            <InactivePatientBadge
                              deletedAt={pat.deleted_at}
                              mergedIntoId={pat.merged_into_id}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-1">
                          {g.items.map((item) => (
                            <ArchiveItemLabel
                              key={item.key}
                              item={item}
                              visitId={g.visitId}
                              membership={membershipFor(item)}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {statusSummary.kind === "uniform" ? (
                          <span
                            className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[statusSummary.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
                          >
                            {testStatusLabel(statusSummary.status)}
                          </span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {statusSummary.entries.map((e) => (
                              <span
                                key={e.status}
                                className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[e.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
                              >
                                {testStatusLabel(e.status)} × {e.count}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Why an unclaimed test is still sitting there: the lab
                            queue hides every line of a visit that hasn't been
                            paid, waived, or billed to an HMO (item 10), so this
                            work isn't waiting on the bench — it's waiting on
                            reception. */}
                        {status === "unclaimed" && g.extra.awaitingPayment ? (
                          <div className="mt-1">
                            {/* Bordered, unlike the sibling status badges, so it
                                doesn't read as another amber `in_progress`
                                chip on the one tab where both can appear. */}
                            <span className="inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              awaiting payment
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime(g.requestedAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.completedAt ? manilaDateTime(g.completedAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.releasedAt ? manilaDateTime(g.releasedAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-1">
                          {g.items
                            .filter((item) => item.amendmentCount > 0 && item.resultId)
                            .map((item) => (
                              <div key={item.key} className="max-w-[16rem]">
                                <span className="font-semibold text-violet-800">
                                  {g.items.length > 1 ? `${item.label}: ` : ""}
                                  Updated {manilaDateTime(item.amendedAt)}
                                  {item.amendmentCount > 1 ? ` (×${item.amendmentCount})` : ""}
                                </span>
                                {lastEditReason.get(item.resultId!) ? (
                                  <span className="text-[color:var(--color-brand-text-mid)]">
                                    {" "}— {lastEditReason.get(item.resultId!)}
                                  </span>
                                ) : null}
                                {staleByResultId.has(item.resultId!) ? (
                                  <span className="block text-amber-800" role="note">
                                    Printed copy out of date
                                  </span>
                                ) : null}
                              </div>
                            ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-1">
                          {g.items.map((item) => (
                            <ArchiveItemActions
                              key={item.key}
                              item={item}
                              visitId={g.visitId}
                              pdfAllowed={canViewItemPdf(item)}
                              patientActive={pat === null || isActivePatient(pat)}
                            />
                          ))}
                        </div>
                      </td>
                      <RemarksCell items={g.items} remarksFor={remarksFor} />
                      <td className="px-4 py-3 text-right text-xs">
                        <Link
                          href={`/staff/visits/${g.visitId}`}
                          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          {g.visitNumber}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hasPartialReport ? (
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          A report&apos;s other tests may be on another page or outside this filter.
        </p>
      ) : null}

      {/* The pager counts TESTS, which is what `.range()` slices; the table
          folds them by visit, so a page of 50 tests renders as fewer rows. */}
      <ListPagination
        page={safePage}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          safePage > 1
            ? buildHref({ page: safePage - 1 > 1 ? String(safePage - 1) : null })
            : null
        }
        nextHref={safePage < totalPages ? buildHref({ page: String(safePage + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((n) => ({
          size: n,
          // Resizing resets to page 1 — same reasoning as a re-sort.
          href: buildHref({
            size: n === DEFAULT_SIZE ? null : String(n),
            page: null,
          }),
        }))}
        noun="test"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// One archive row is a whole visit, so its remarks are listed per item — a
// single test, or a chemistry report whose members were claimed together (a
// group claim writes one event per member; claimRemarks folds those into one
// line, as on the chemistry page). The item label heads each block when the
// visit has more than one item.
function RemarksCell({
  items,
  remarksFor,
}: {
  items: ArchiveItem[];
  remarksFor: (testIds: string[]) => ReturnType<typeof claimRemarks>;
}) {
  const blocks = items
    .map((item) => ({ item, remarks: remarksFor(item.tests.map((t) => t.id)) }))
    .filter((b) => b.remarks.length > 0);
  if (blocks.length === 0) {
    return (
      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">—</td>
    );
  }
  return (
    <td className="min-w-48 max-w-xs px-4 py-3 text-xs">
      <div className="flex flex-col gap-2">
        {blocks.map(({ item, remarks }) => (
          <div key={item.key}>
            {items.length > 1 ? (
              <p className="font-semibold text-[color:var(--color-brand-text-soft)]">{item.label}</p>
            ) : null}
            <ClaimRemarksList remarks={remarks} max={MAX_REMARKS_SHOWN} />
          </div>
        ))}
      </div>
    </td>
  );
}

/** Where an item opens: a single test's page, or the report-group page
 * scrolled to this report's card. */
function itemHref(item: ArchiveItem, visitId: string): string {
  if (item.kind === "test") return `/staff/queue/${item.tests[0].id}`;
  const anchor = item.resultId ? `#result-${item.resultId}` : "";
  return `/staff/queue/consolidated/${visitId}/${item.reportGroupId}${anchor}`;
}

/** Statuses at which a single test's result can be edited (amended) on its
 * page — mirrors `amendable` in queue/[id]/page.tsx. */
const EDITABLE_STATUSES = new Set(["result_uploaded", "ready_for_release", "released"]);

function ArchiveItemLabel({
  item,
  visitId,
  membership,
}: {
  item: ArchiveItem;
  visitId: string;
  membership: MembershipDisplay;
}) {
  if (item.kind === "report") {
    return (
      <div>
        <Link
          href={itemHref(item, visitId)}
          className="font-semibold text-[color:var(--color-brand-navy)] hover:underline"
        >
          {item.label} ({membership.text})
        </Link>
        <div className="text-[color:var(--color-brand-text-soft)]">
          {item.tests.map((t) => t.name || t.code).join(" · ")}
        </div>
      </div>
    );
  }
  const t = item.tests[0];
  return (
    <div>
      {/* The code only repeats the name for 265 of 273 services, which read
          as every test listed twice — show it only when it adds something. */}
      {codeDuplicatesName(t.code, t.name) ? null : (
        <span className="font-mono text-[color:var(--color-brand-text-soft)]">{t.code} </span>
      )}
      <Link href={itemHref(item, visitId)} className="text-[color:var(--color-brand-navy)] hover:underline">
        {t.name || t.code}
      </Link>
    </div>
  );
}

function ArchiveItemActions({
  item,
  visitId,
  pdfAllowed,
  patientActive,
}: {
  item: ArchiveItem;
  visitId: string;
  /** Every-member section check (0179) — a shared report PDF still carries a
   *  deleted member's values, so a lab role must cover every linked test,
   *  not just the live ones this row shows. */
  pdfAllowed: boolean;
  /** 0167: a deleted/merged patient's result stays viewable but not editable. */
  patientActive: boolean;
}) {
  const editable =
    patientActive &&
    item.kind === "test" &&
    item.resultId !== null &&
    EDITABLE_STATUSES.has(item.tests[0].status);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      {item.pdfTestRequestId && pdfAllowed ? (
        <a
          href={`/staff/results/${item.pdfTestRequestId}/pdf`}
          target="_blank"
          rel="noopener"
          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          {item.label} PDF →
        </a>
      ) : (
        <span className="text-[color:var(--color-brand-text-soft)]">{item.label} —</span>
      )}
      {editable ? (
        <Link
          href={itemHref(item, visitId)}
          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Edit
        </Link>
      ) : null}
    </div>
  );
}

type StatusSummary =
  | { kind: "uniform"; status: string }
  | { kind: "mixed"; entries: { status: string; count: number }[] };

function summarizeStatuses(statuses: string[]): StatusSummary {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  if (counts.size === 1) {
    return { kind: "uniform", status: statuses[0] };
  }
  // Most-progressed first so the user reads the headline status at a glance.
  const order = ["released", "ready_for_release", "result_uploaded", "in_progress", "requested", "cancelled"];
  const entries = Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return { kind: "mixed", entries };
}

