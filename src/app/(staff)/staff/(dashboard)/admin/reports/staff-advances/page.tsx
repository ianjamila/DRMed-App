import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { manilaDate } from "@/lib/dates/manila";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  compareStaffAdvanceRows,
  compareStaffAdvanceSummaryRows,
  loadStaffAdvances,
  staffAdvancesCsvHref,
  STAFF_ADVANCES_DEFAULT_SORT,
  STAFF_ADVANCES_SORTABLE_COLUMNS,
  STAFF_ADVANCES_SUMMARY_DEFAULT_SORT,
  STAFF_ADVANCES_SUMMARY_SORTABLE_COLUMNS,
  type StaffAdvanceSortColumn,
  type StaffAdvanceSummarySortColumn,
} from "@/lib/reports/staff-advances";
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

export const metadata = { title: "Staff advances" };
export const dynamic = "force-dynamic";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const BASE_PATH = "/staff/admin/reports/staff-advances";

interface SearchParams {
  sort?: string;
  dir?: string;
  page?: string;
  size?: string;
  ssort?: string;
  sdir?: string;
}

export default async function StaffAdvancesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;
  const admin = createAdminClient();
  const { summary, rows, staffById, truncated } = await loadStaffAdvances(
    admin,
    REPORT_EXPORT_MAX_ROWS,
  );

  // Ledger ("Recent advances") — the full sort+page contract.
  const sort = parseSort(
    params.sort,
    params.dir,
    STAFF_ADVANCES_SORTABLE_COLUMNS,
    STAFF_ADVANCES_DEFAULT_SORT,
  );
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);
  const total = rows.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  const pageRows = [...rows]
    .sort((a, b) => compareStaffAdvanceRows(a, b, sort, staffById))
    .slice(from, to + 1);

  // Summary ("Outstanding by staff") — sort only, no pager: one row per
  // staff member with an open balance, same call as `Closures`.
  const ssort = parseSort(
    params.ssort,
    params.sdir,
    STAFF_ADVANCES_SUMMARY_SORTABLE_COLUMNS,
    STAFF_ADVANCES_SUMMARY_DEFAULT_SORT,
  );
  const summaryRows = [...summary].sort((a, b) => compareStaffAdvanceSummaryRows(a, b, ssort));

  const isDefaultSort =
    sort.key === STAFF_ADVANCES_DEFAULT_SORT.key && sort.dir === STAFF_ADVANCES_DEFAULT_SORT.dir;
  const isDefaultSummarySort =
    ssort.key === STAFF_ADVANCES_SUMMARY_DEFAULT_SORT.key &&
    ssort.dir === STAFF_ADVANCES_SUMMARY_DEFAULT_SORT.dir;

  // One params record for the whole page — each table's own keys are
  // omitted at their default, and every href below carries BOTH tables'
  // state, or a reader sorting one would silently lose the other's.
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
    ssort: isDefaultSummarySort ? null : ssort.key,
    sdir: isDefaultSummarySort ? null : ssort.dir,
  };

  // Ledger controls: sorting or changing page size resets to page 1 (sitting
  // on page 7 of a set whose order just changed is a blank screen with no
  // explanation) — but never touches the summary table's own `ssort`/`sdir`,
  // which baseParams already carries.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: StaffAdvanceSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === STAFF_ADVANCES_DEFAULT_SORT.key && next.dir === STAFF_ADVANCES_DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: StaffAdvanceSortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  // Summary controls: re-sorting "Outstanding by staff" doesn't change the
  // ledger's row order, so — unlike `href` above — this keeps the reader's
  // current ledger page instead of bouncing them back to page 1.
  const summaryHref = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, {
      page: page > 1 ? String(page) : null,
      ...overrides,
    });

  const summarySortHref = (key: StaffAdvanceSummarySortColumn) => {
    const next = nextSort(ssort, key);
    const nextIsDefault =
      next.key === STAFF_ADVANCES_SUMMARY_DEFAULT_SORT.key &&
      next.dir === STAFF_ADVANCES_SUMMARY_DEFAULT_SORT.dir;
    return summaryHref({
      ssort: nextIsDefault ? null : next.key,
      sdir: nextIsDefault ? null : next.dir,
    });
  };

  const sth = (key: StaffAdvanceSummarySortColumn, label: string) => (
    <SortableTh key={key} label={label} href={summarySortHref(key)} state={ariaSortFor(ssort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Books &amp; Reports</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">Staff advances</h1>
          <ExportCsvLink href={staffAdvancesCsvHref()} />
        </div>
      </header>

      <section className="mb-6 overflow-x-auto rounded-lg border bg-white shadow-sm">
        <h2 className="px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">Outstanding by staff</h2>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-[color:var(--color-bg-mid)] text-left">
              {sth("staff", "Staff")}
              {sth("role", "Role")}
              {sth("advances", "Advances")}
              {sth("outstanding", "Outstanding")}
              {sth("oldest", "Oldest")}
            </tr>
          </thead>
          <tbody>
            {summaryRows.map((r) => (
              <tr key={r.staff_id} className="border-t">
                <td className="px-3 py-2">{r.full_name}</td>
                <td className="px-3 py-2">{r.role}</td>
                <td className="px-3 py-2">{r.advance_count}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.outstanding_php ?? 0))}</td>
                <td className="px-3 py-2">{manilaDate(r.oldest_advance_date)}</td>
              </tr>
            ))}
            {summaryRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-[color:var(--color-brand-text-soft)]">
                  No outstanding advances.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <h2 className="px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">Recent advances</h2>
        {truncated ? (
          <p className="mx-3 mb-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} advances — export for the full ledger.
          </p>
        ) : null}
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="bg-[color:var(--color-bg-mid)] text-left">
              {th("date", "Date")}
              {th("staff", "Staff")}
              {th("original", "Original")}
              {th("outstanding", "Outstanding")}
              {th("status", "Status")}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">{manilaDate(r.business_date)}</td>
                <td className="px-3 py-2">
                  {staffById.get(r.staff_id)?.full_name ?? (
                    <span className="font-mono text-xs">{r.staff_id.slice(0, 8)}…</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.original_amount_php))}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.outstanding_balance_php))}</td>
                <td className="px-3 py-2">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="px-3 pb-3">
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
            noun="advance"
          />
        </div>
      </section>
    </div>
  );
}
