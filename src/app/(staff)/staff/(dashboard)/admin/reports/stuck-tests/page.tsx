import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/staff/page-header";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { pluckOne } from "@/lib/reports/format";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  ageDays,
  compareStuckRows,
  loadStuckTests,
  parseStuckTestsParams,
  STUCK_DEFAULT_SORT,
  STUCK_SORTABLE_COLUMNS,
  stuckTestsCsvHref,
  type StuckSortColumn,
} from "@/lib/reports/stuck-tests";
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
} from "@/lib/ui/table-params";
import { SortableTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = { title: "Stuck Tests" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/reports/stuck-tests";

// Mirrors parseStuckTestsParams' own fallback — kept in sync there, not
// re-derived here, so the "days" param can be omitted from a link exactly
// when it wouldn't change what the loader fetches.
const DEFAULT_DAYS = 3;

interface SearchProps {
  searchParams: Promise<{
    days?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  result_uploaded: "bg-amber-100 text-amber-900",
  ready_for_release: "bg-emerald-100 text-emerald-900",
};

const PAYMENT_STYLE: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-emerald-100 text-emerald-900",
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
};

export default async function StuckTestsPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;
  const params = parseStuckTestsParams(sp);
  const { days } = params;
  const sort = parseSort(sp.sort, sp.dir, STUCK_SORTABLE_COLUMNS, STUCK_DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const admin = createAdminClient();
  // Raised from a flat 500 to match the CSV export's own ceiling — a pager
  // whose total comes from a 500-capped fetch can assert "of 500" while more
  // rows actually match (the AP bills bug, #170). Only the main `stuck` table
  // below is sorted and paged; the three integrity lists keep their own flat
  // 100-row cap and fixed order (see the comment in stuck-tests.ts).
  const { stuck, stuckHeaders, orphanHeaders, emptyVisits, claimerNames, truncated } =
    await loadStuckTests(admin, params, REPORT_EXPORT_MAX_ROWS);

  const total = stuck.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  // Sort, then slice — the whole set fetched above is already in memory, so
  // paging here is a plain array slice rather than a second round-trip.
  const rows = [...stuck]
    .sort((a, b) => compareStuckRows(a, b, sort, claimerNames))
    .slice(from, to + 1);

  const isDefaultDays = days === DEFAULT_DAYS;
  const isDefaultSort = sort.key === STUCK_DEFAULT_SORT.key && sort.dir === STUCK_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    days: isDefaultDays ? null : String(days),
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  // Sort/page links reset to page 1 — sitting on page 7 of a result set that
  // just changed shape (a new sort column, a new day threshold) is a blank
  // screen with no explanation.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: StuckSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === STUCK_DEFAULT_SORT.key && next.dir === STUCK_DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: StuckSortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Stuck Tests"
        subtitle={`Lab tests sitting longer than ${days} day${days === 1 ? "" : "s"} in any non-final state — unclaimed, in progress, or ready but unreleased — so nothing silently stalls. Consultations and procedures are excluded; they have no bench step, so they are followed up on Visits, not here.`}
        actions={
          <form method="GET" className="flex items-center gap-2 text-sm">
            <label
              htmlFor="days"
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
            >
              Older than
            </label>
            <input
              id="days"
              type="number"
              name="days"
              min={1}
              max={365}
              defaultValue={days}
              className="w-20 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
            />
            <span className="text-xs text-[color:var(--color-brand-text-soft)]">
              days
            </span>
            {/* A plain GET form only submits the fields it carries — without
                these, changing the day threshold would silently drop the
                reader's current sort and page size. */}
            {isDefaultSort ? null : (
              <>
                <input type="hidden" name="sort" value={sort.key} />
                <input type="hidden" name="dir" value={sort.dir} />
              </>
            )}
            {size === DEFAULT_PAGE_SIZE ? null : (
              <input type="hidden" name="size" value={size} />
            )}
            <button
              type="submit"
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white hover:opacity-90"
            >
              Apply
            </button>
            <ExportCsvLink href={stuckTestsCsvHref(params)} />
          </form>
        }
      />

      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the oldest {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows — there may be
          more. Raise the day threshold to narrow the list, or export for everything.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("age", "Age")}
              {th("visit", "Visit")}
              {th("patient", "Patient")}
              {th("test", "Test")}
              {th("status", "Status")}
              {th("claimed", "Claimed by")}
              {th("payment", "Visit payment")}
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  Nothing stuck older than {days} day{days === 1 ? "" : "s"}. 🎉
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const svc = pluckOne(r.services);
                const visit = pluckOne(r.visits);
                const patient = visit ? pluckOne(visit.patients) : null;
                return (
                  <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {ageDays(r.requested_at)}d
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime(r.requested_at)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/visits/${r.visit_id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        #{visit?.visit_number ?? "?"}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {patient
                          ? `${patient.last_name}, ${patient.first_name}`
                          : "—"}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {patient?.drm_id ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/queue/${r.id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {svc?.name ?? "(unknown)"}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {svc?.code ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[r.status] ?? ""
                        }`}
                      >
                        {r.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {r.assigned_to
                        ? (claimerNames.get(r.assigned_to) ?? "—")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          PAYMENT_STYLE[visit?.payment_status ?? ""] ?? ""
                        }`}
                      >
                        {(visit?.payment_status ?? "—").replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      <ListPagination
        page={page}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          page > 1
            ? buildListHref(BASE_PATH, baseParams, {
                page: page - 1 > 1 ? String(page - 1) : null,
              })
            : null
        }
        nextHref={
          page < totalPages
            ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) })
            : null
        }
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: href({ size: s === DEFAULT_PAGE_SIZE ? null : String(s) }),
        }))}
        noun="stuck test"
      />

      <section className="mt-8">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Package headers that should have auto-released
        </h2>
        <p className="mb-3 text-sm text-[color:var(--color-brand-text-soft)]">
          Headers still at &quot;ready for release&quot; on a paid visit with
          every component finished and at least one released — the class of
          stall Visit #0037 hit. Since the auto-release fix this list should
          always be empty; anything appearing here means the auto-release
          didn&apos;t fire — investigate.
        </p>
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Visit</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Package</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {stuckHeaders.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    None — header auto-release is working.
                  </td>
                </tr>
              ) : (
                stuckHeaders.map((h) => {
                  const svc = pluckOne(h.services);
                  const visit = pluckOne(h.visits);
                  const patient = visit ? pluckOne(visit.patients) : null;
                  return (
                    <tr key={h.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {ageDays(h.requested_at)}d
                        </p>
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {manilaDateTime(h.requested_at)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${h.visit_id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{visit?.visit_number ?? "?"}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patient
                            ? `${patient.last_name}, ${patient.first_name}`
                            : "—"}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {patient?.drm_id ?? "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/queue/${h.id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {svc?.name ?? "(unknown)"}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {svc?.code ?? "—"}
                        </p>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Package headers with no test lines
        </h2>
        <p className="mb-3 text-sm text-[color:var(--color-brand-text-soft)]">
          Package orders whose individual tests were never created — usually a
          visit creation that was interrupted partway. Results can never be
          entered against these, so they will sit forever unless repaired.
          Since visit creation became a single all-or-nothing step this list
          should always be empty; anything appearing here needs its components
          backfilled (the 0130 migration shape) — investigate.
        </p>
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Visit</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Package</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {orphanHeaders.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    None — every package order has its test lines.
                  </td>
                </tr>
              ) : (
                orphanHeaders.map((h) => {
                  const svc = pluckOne(h.services);
                  const visit = pluckOne(h.visits);
                  const patient = visit ? pluckOne(visit.patients) : null;
                  return (
                    <tr key={h.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {ageDays(h.requested_at)}d
                        </p>
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {manilaDateTime(h.requested_at)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${h.visit_id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{visit?.visit_number ?? "?"}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patient
                            ? `${patient.last_name}, ${patient.first_name}`
                            : "—"}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {patient?.drm_id ?? "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/queue/${h.id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {svc?.name ?? "(unknown)"}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {svc?.code ?? "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            TEST_STATUS_STYLE[h.status] ?? ""
                          }`}
                        >
                          {h.status.replace(/_/g, " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Visits with no services at all
        </h2>
        <p className="mb-3 text-sm text-[color:var(--color-brand-text-soft)]">
          Visits carrying zero service lines — the leftover of a visit
          creation that was interrupted between saving the visit and saving
          its services (only visits older than an hour are listed, so one
          being created right now never shows). The patient was likely
          re-entered a moment later, so these are usually safe to delete from
          the visit page — but check for a duplicate visit first.
        </p>
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Visit</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Visit payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {emptyVisits.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    None — every visit has service lines.
                  </td>
                </tr>
              ) : (
                emptyVisits.map((v) => {
                  const patient = pluckOne(v.patients);
                  return (
                    <tr key={v.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {ageDays(v.created_at)}d
                        </p>
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {manilaDateTime(v.created_at)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${v.id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{v.visit_number}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patient
                            ? `${patient.last_name}, ${patient.first_name}`
                            : "—"}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {patient?.drm_id ?? "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        {formatPhp(v.total_php)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            PAYMENT_STYLE[v.payment_status] ?? ""
                          }`}
                        >
                          {v.payment_status.replace(/_/g, " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>
      </section>
    </div>
  );
}
