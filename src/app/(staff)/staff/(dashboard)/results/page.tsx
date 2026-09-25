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
import { matchesAllTokens } from "@/lib/patients/search";
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
  type ArchiveItem,
  type ArchiveResultLink,
  type ArchiveTestRow,
} from "@/lib/results/archive-fold";
import { codeDuplicatesName } from "@/lib/results/consolidated-reports";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

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
    patients: { first_name: string; last_name: string; drm_id: string } | null;
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

  const admin = createAdminClient();

  let query = admin
    .from("test_requests")
    .select(
      `
        id, status, released_at, completed_at, requested_at,
        visits!inner ( id, visit_number, payment_status, hmo_provider_id,
          patients!inner ( first_name, last_name, drm_id ) ),
        services!inner ( code, name, kind, section, report_group_id, report_groups ( name ) )
      `,
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

  const { data, count } = await query.returns<ResultRow[]>();
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

  // The latest edit's reason per amended result, for the Edited column. Only
  // results on this page with amendment_count > 0, so this is empty on almost
  // every render and bounded by the page size when it isn't.
  const amendedIds = Array.from(
    new Set(
      Array.from(linkByTrId.values())
        .filter((l) => l.amendmentCount > 0)
        .map((l) => l.resultId),
    ),
  );
  const lastEditReason = new Map<string, string>();
  if (amendedIds.length > 0) {
    const { data: amends } = await admin
      .from("result_amendments")
      .select("result_id, reason, amendment_seq")
      .in("result_id", amendedIds)
      .order("amendment_seq", { ascending: false });
    for (const am of amends ?? []) {
      if (!lastEditReason.has(am.result_id)) lastEditReason.set(am.result_id, am.reason);
    }
  }

  // Remarks column: each test's claim history, same reader and wording as the
  // lab queue. Called through the signed-in staff client, NOT `admin` above —
  // queue_claim_remarks gates on the caller's role, and the service role has
  // none, so it would answer empty.
  const claimEvents = await fetchClaimEvents(await createClient(), trIds);
  const remarksFor = (testIds: string[]) =>
    claimRemarks(testIds.flatMap((id) => claimEvents.get(id) ?? []));

  // Optional client-side filter when q is set. Server-side ilike across a join
  // is awkward in PostgREST, so post-filter the page rows here. Token-based:
  // every word must appear somewhere (name / DRM-ID / service), in any order.
  const filtered = q
    ? rows.filter((r) => {
        const pat = r.visits?.patients;
        const name = pat ? `${pat.first_name} ${pat.last_name}` : "";
        const drm = pat?.drm_id ?? "";
        const svc = `${r.services?.code ?? ""} ${r.services?.name ?? ""}`;
        return matchesAllTokens(`${name} ${drm} ${svc}`, q);
      })
    : rows;

  // The fold works on plain rows; the lab-gate flag is per visit.
  const awaitingByVisit = new Map<string, boolean>();
  const archiveRows: ArchiveTestRow[] = [];
  for (const r of filtered) {
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

  const hasFilters = Boolean(start || end || q || status !== "all");

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
            {/* `q` is applied after the fetch (see below), so `total` is the
                count BEFORE it — say what it actually counts rather than
                calling a larger number "matching". */}
            {q
              ? ` · ${total.toLocaleString("en-PH")} match the filters · ${filtered.length} on this page match “${q}”`
              : hasFilters
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
                page: null,
              })}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      {/* The search box narrows the fetched page only — the dates and the tab
          are real DB filters, this one is not. Say so, the way the lab queue
          does, rather than let a page-1 miss read as "not in the archive". */}
      {q && totalPages > 1 ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          The search box only looks at the {size} tests on this page. Narrow the
          dates, or pick a tab, to search a smaller set.
        </p>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {status === "unclaimed" && !start && !end && !q
              ? "Nothing is waiting to be picked up — every test in progress has someone on it."
              : "No results match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {/* Patient, Tests, Edited and PDF can't be ordered — see SORTABLE_COLUMNS. */}
                  <PlainTh label="Patient" />
                  <PlainTh label="Tests" />
                  {th("status", "Status")}
                  {th("requested_at", "Requested")}
                  {th("completed_at", "Completed")}
                  {th("released_at", "Released")}
                  <PlainTh label="Edited" />
                  <PlainTh label="PDF" />
                  <PlainTh label="Remarks" />
                  {th("visit_number", "Visit", "right")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {foldArchiveRows(archiveRows, linkByTrId, (r) => ({
                  awaitingPayment: awaitingByVisit.get(r.visit.id) ?? false,
                })).map((g) => {
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
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-1">
                          {g.items.map((item) => (
                            <ArchiveItemLabel key={item.key} item={item} visitId={g.visitId} />
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
                                  Edited {manilaDateTime(item.amendedAt)}
                                  {item.amendmentCount > 1 ? ` (×${item.amendmentCount})` : ""}
                                </span>
                                {lastEditReason.get(item.resultId!) ? (
                                  <span className="text-[color:var(--color-brand-text-mid)]">
                                    {" "}— {lastEditReason.get(item.resultId!)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-1">
                          {g.items.map((item) => (
                            <ArchiveItemActions key={item.key} item={item} visitId={g.visitId} />
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

function ArchiveItemLabel({ item, visitId }: { item: ArchiveItem; visitId: string }) {
  if (item.kind === "report") {
    return (
      <div>
        <Link
          href={itemHref(item, visitId)}
          className="font-semibold text-[color:var(--color-brand-navy)] hover:underline"
        >
          {item.label} ({item.tests.length} {item.tests.length === 1 ? "test" : "tests"})
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

function ArchiveItemActions({ item, visitId }: { item: ArchiveItem; visitId: string }) {
  const editable =
    item.kind === "test" && item.resultId !== null && EDITABLE_STATUSES.has(item.tests[0].status);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      {item.pdfTestRequestId ? (
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

