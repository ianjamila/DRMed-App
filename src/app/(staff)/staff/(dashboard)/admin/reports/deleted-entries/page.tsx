import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate, manilaDateTime } from "@/lib/dates/manila";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
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
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  compareDeletedEntries,
  DELETED_ENTRIES_DEFAULT_SORT,
  DELETED_ENTRIES_SORTABLE_COLUMNS,
  deletedEntriesCsvHref,
  loadDeletedEntries,
  parseDeletedEntriesParams,
  type DeletedEntriesSortColumn,
} from "@/lib/reports/deleted-entries";

export const metadata = { title: "Deleted Queue Entries" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/reports/deleted-entries";

interface SearchProps {
  searchParams: Promise<{
    start?: string;
    end?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function DeletedEntriesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const params = parseDeletedEntriesParams(sp, todayISO);
  const { start, end } = params;
  const sort = parseSort(sp.sort, sp.dir, DELETED_ENTRIES_SORTABLE_COLUMNS, DELETED_ENTRIES_DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const admin = createAdminClient();
  // Ceiling raised from the old flat 500 to match the CSV export's own
  // fetch (rule 6 of the tier-c sort contract) — a pager whose total comes
  // from a 500-capped fetch can assert "of 500" while more rows match. As a
  // side effect, the four summary tiles below (computed from this same
  // fetched set) go from "capped at 500" to exact whenever the window fits
  // under the new ceiling — they only stay approximate when `truncated`.
  const { entries, summary, truncated } = await loadDeletedEntries(
    admin,
    params,
    REPORT_EXPORT_MAX_ROWS,
  );
  const { deleteEvents, restoreEvents, stillDeleted, deletedValue } = summary;

  const total = entries.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  // Sort, then slice — `entries` is already the whole date-windowed set in
  // memory (see the SORTABLE_COLUMNS comment in the lib module), so paging
  // here is a plain array slice rather than a second round-trip.
  const rows = [...entries]
    .sort((a, b) => compareDeletedEntries(a, b, sort))
    .slice(from, to + 1);

  const isDefaultSort =
    sort.key === DELETED_ENTRIES_DEFAULT_SORT.key && sort.dir === DELETED_ENTRIES_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    start,
    end,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  // Every header/pager link keeps the date range and resets to page 1 —
  // changing the sort while sitting on page 9 of a range that just
  // reordered is a blank screen with no explanation.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: DeletedEntriesSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === DELETED_ENTRIES_DEFAULT_SORT.key && next.dir === DELETED_ENTRIES_DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: DeletedEntriesSortColumn, label: string, align?: "left" | "right") => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} align={align} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Deleted Queue Entries
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Every visit or test deleted from the queues — who deleted it, why,
          what it was worth, and whether it was restored since. Only unpaid
          entries can be deleted; anything with payments has to go through a
          payment void first.
        </p>
      </header>

      <form
        action=""
        className="my-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Deleted from
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
        {/* A plain-GET filter form submits only the fields it carries — without
            these three, applying the date range would silently reset the
            reader's sort and page size (rule 5 of the tier-c sort contract).
            `page` is deliberately NOT carried: a changed range is a new result
            set, and page 1 is the only page guaranteed to exist in it. */}
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
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        <ExportCsvLink href={deletedEntriesCsvHref(params)} />
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Delete events"
          value={String(deleteEvents)}
          hint={`${start} → ${end}`}
        />
        <SummaryTile
          label="Still deleted"
          value={String(stillDeleted)}
          hint="Not restored since"
          tone={stillDeleted > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Restores"
          value={String(restoreEvents)}
          hint="Entries put back in the queue"
        />
        <SummaryTile
          label="Deleted value"
          value={formatPhp(deletedValue)}
          hint="Billed value removed at delete time"
        />
      </div>

      {truncated ? (
        <p className="mb-3 text-xs text-amber-700">
          Showing the most recent {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} —
          narrow the range to see the rest.
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No queue entries were deleted or restored in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("when", "When")}
                  {th("event", "Event")}
                  {th("patient", "Patient")}
                  {th("visit", "Visit")}
                  {th("what", "What")}
                  {th("by", "By")}
                  <PlainTh label="Reason" />
                  {th("amount", "Amount", "right")}
                  {th("outcome", "Current outcome")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((e) => {
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime(e.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            e.isDelete
                              ? "bg-red-100 text-red-900"
                              : "bg-emerald-100 text-emerald-900"
                          }`}
                        >
                          {e.isDelete ? "Deleted" : "Restored"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {e.patient ? (
                          <>
                            {e.patient.last_name}, {e.patient.first_name}{" "}
                            <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                              {e.patient.drm_id}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {e.visitHref ? (
                          <Link href={e.visitHref} className="hover:underline">
                            #{e.visitNumber ?? "—"}
                          </Link>
                        ) : (
                          <>#{e.visitNumber ?? "—"}</>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.isVisit ? (
                          <>
                            Entire visit
                            {e.activeTestCount != null ? (
                              <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
                                {e.activeTestCount}{" "}
                                {e.activeTestCount === 1 ? "test" : "tests"}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            {e.serviceName ?? "—"}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {e.serviceCode ?? ""}
                              {e.isPackageHeader ? " · package" : ""}
                            </p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">{e.actorName ?? "—"}</td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {e.reason ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {e.amount != null && e.amount > 0 ? formatPhp(e.amount) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {e.currentlyDeleted ? (
                          <span className="font-semibold text-red-700">
                            Still deleted
                          </span>
                        ) : (
                          <span className="font-semibold text-emerald-700">
                            Back in the queue
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
        noun="entry"
        plural="entries"
      />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  const accent =
    tone === "warn"
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
