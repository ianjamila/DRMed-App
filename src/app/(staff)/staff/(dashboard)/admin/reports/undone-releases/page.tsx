import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { manilaDate, manilaDateTime, todayManilaISODate } from "@/lib/dates/manila";
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
  compareUndoneReleases,
  loadUndoneReleases,
  parseUndoneReleasesParams,
  UNDONE_RELEASES_DEFAULT_SORT,
  UNDONE_RELEASES_SORTABLE_COLUMNS,
  undoneReleasesCsvHref,
  type UndoneReleasesSortColumn,
} from "@/lib/reports/undone-releases";

export const metadata = { title: "Undone Releases" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/reports/undone-releases";

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

export default async function UndoneReleasesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const params = parseUndoneReleasesParams(sp, todayISO);
  const { start, end } = params;
  const sort = parseSort(sp.sort, sp.dir, UNDONE_RELEASES_SORTABLE_COLUMNS, UNDONE_RELEASES_DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const admin = createAdminClient();
  // Ceiling raised from the old flat 500 to match the CSV export's own walk
  // (REPORT_EXPORT_MAX_ROWS) — a pager built on a 500-capped fetch would
  // assert "showing 1-25 of 500" while more rows actually match, the same
  // bug closed on the AP bills index. This also makes the four summary tiles
  // below exact for any range under the new ceiling, instead of silently
  // capping at 500 the way they used to when the range was wide.
  const { entries, summary, truncated: capped } = await loadUndoneReleases(
    admin,
    params,
    REPORT_EXPORT_MAX_ROWS,
  );
  const { staffUndos, stillUnreleased, reReleased, viewedBeforeUndo } = summary;

  const total = entries.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  // Sort, then slice — the whole date-range window is already in memory (see
  // the SORTABLE_COLUMNS comment in undone-releases.ts), so paging here is a
  // plain array slice rather than a second round-trip.
  const rows = [...entries].sort((a, b) => compareUndoneReleases(a, b, sort)).slice(from, to + 1);

  // Params at their default are omitted so the plain filter/sort state stays
  // the bare BASE_PATH URL. `page` is deliberately never carried in
  // baseParams — every filter/sort change resets to page 1 (see `href`).
  const isDefaultSort =
    sort.key === UNDONE_RELEASES_DEFAULT_SORT.key && sort.dir === UNDONE_RELEASES_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    start,
    end,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: UndoneReleasesSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === UNDONE_RELEASES_DEFAULT_SORT.key && next.dir === UNDONE_RELEASES_DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: UndoneReleasesSortColumn, label: string, align?: "left" | "right") => (
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
          Undone Releases
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Every result release that was withdrawn — who undid it, why, whether
          the patient had already seen it, and what has happened to the result
          since (RA 10173 oversight). Cascade rows are the system flipping a
          package header back after its component was undone.
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
            Undone from
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
        <ExportCsvLink href={undoneReleasesCsvHref(params)} />
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Undo events"
          value={String(total)}
          hint={`${staffUndos} by staff · ${total - staffUndos} cascade — ${start} → ${end}`}
        />
        <SummaryTile
          label="Still unreleased"
          value={String(stillUnreleased)}
          hint="Pulled and not re-released yet"
          tone={stillUnreleased > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Re-released"
          value={String(reReleased)}
          hint="Corrected and released again"
        />
        <SummaryTile
          label="Viewed before undo"
          value={String(viewedBeforeUndo)}
          hint="Patient had already opened the result"
          tone={viewedBeforeUndo > 0 ? "warn" : "ok"}
        />
      </div>

      {capped ? (
        <p className="mb-3 text-xs text-amber-700">
          Showing the most recent {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} — narrow the
          range to see the rest.
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No releases were undone in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("when", "When")}
                  {th("patient", "Patient · Visit")}
                  {th("test", "Test")}
                  {th("by", "Undone by")}
                  <PlainTh label="Reason" />
                  {th("viewed", "Viewed", "right")}
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
                        {e.visitId ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            <Link
                              href={`/staff/visits/${e.visitId}`}
                              className="hover:underline"
                            >
                              #{e.visitNumber ?? "—"}
                            </Link>
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {e.serviceName ? (
                          <>
                            {e.serviceName}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {e.serviceCode}
                            </p>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.isCascade ? (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            System (package cascade)
                          </span>
                        ) : (
                          (e.actorName ?? "—")
                        )}
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {e.isCascade
                          ? "Followed its component's undo"
                          : (e.reason ?? "—")}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {e.isCascade ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : e.viewedCount == null ? (
                          <span
                            className="text-[color:var(--color-brand-text-soft)]"
                            title="Recorded before viewed-count tracking"
                          >
                            —
                          </span>
                        ) : e.viewedCount > 0 ? (
                          <span className="font-semibold text-amber-700">
                            {e.viewedCount}×
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {!e.currentStatus ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : e.currentStatus === "released" ? (
                          <span className="font-semibold text-emerald-700">
                            Re-released{" "}
                            {e.releasedAt ? manilaDate(e.releasedAt) : ""}
                          </span>
                        ) : e.currentStatus === "ready_for_release" ? (
                          <span className="font-semibold text-amber-700">
                            Still unreleased
                          </span>
                        ) : e.currentStatus === "cancelled" ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            Cancelled
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            {e.currentStatus.replace(/_/g, " ")}
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
        noun="undo"
        plural="undos"
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
