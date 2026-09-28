import { VisitsSearchInput } from "./_components/visits-search-input";
import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { parseSampleFilter } from "@/lib/visits/sample";
import { SampleBadge } from "@/components/staff/sample-badge";
import { createClient } from "@/lib/supabase/server";
import { isISODate, manilaDate, todayManilaISODate } from "@/lib/dates/manila";
import { VisitsTabs } from "./_components/visits-tabs";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { formatPatientName } from "@/lib/patients/format-name";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { CLASS_BADGE, RevenueByClass } from "@/components/staff/revenue-by-class";
import { buildRevenuePresets, matchRevenuePreset } from "@/lib/visits/revenue-presets";
import { priorYearRange } from "@/lib/reports/period-presets";
import { PageHeader } from "@/components/staff/page-header";
import { sectionTabClass } from "@/components/staff/section-tabs-style";
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
import {
  ARCHIVE_SORT_COLUMNS,
  DEFAULT_ARCHIVE_SORT,
  fetchArchiveWindow,
  type ArchiveRow,
  type ArchiveSortColumn,
} from "@/lib/visits/archive-query";
import {
  isVisitView,
  parseVisitClasses,
  serialiseVisitClasses,
  summariseClasses,
  summaryTotals,
  toggleVisitClass,
  VISIT_CLASSES,
  VISIT_CLASS_LABEL,
  VISIT_VIEWS,
  VISIT_VIEW_LABEL,
  type VisitClass,
} from "@/lib/visits/classification";

export const metadata = {
  title: "Visit Records",
};

const BASE_PATH = "/staff/visits";

/** Column labels for the sortable headers — kept beside the allow-list. */
const SORT_LABEL: Record<ArchiveSortColumn, string> = {
  visit_date: "Date",
  visit_number: "Visit #",
  patient_last_name: "Patient",
  total_php: "Total",
  paid_php: "Paid",
  payment_status: "Status",
};

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const STATUS_BADGE: Record<string, string> = {
  paid: "bg-green-50 text-green-700 border-green-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  waived: "bg-blue-50 text-blue-700 border-blue-200",
};

interface SearchProps {
  searchParams: Promise<{
    q?: string;
    start?: string;
    end?: string;
    page?: string;
    size?: string;
    sort?: string;
    dir?: string;
    kind?: string;
    view?: string;
    sample?: string;
    rev?: string;
  }>;
}

function visitNo(n: string): string {
  return `#${String(n).padStart(4, "0")}`;
}

export default async function VisitsIndexPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  const params = await searchParams;
  const query = (params.q ?? "").trim();

  const start = isISODate(params.start) ? params.start : "";
  const end = isISODate(params.end) ? params.end : "";
  const classes = parseVisitClasses(params.kind);
  const view = isVisitView(params.view) ? params.view : "active";
  const sampleOnly = parseSampleFilter(params.sample);
  // Keeps the admin revenue dropdown open across a click on one of its own
  // cards (which reloads the page) — it is otherwise closed by default.
  const revenueOpen = params.rev === "1";
  const sort = parseSort(params.sort, params.dir, ARCHIVE_SORT_COLUMNS, DEFAULT_ARCHIVE_SORT);
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);
  const [offset] = rangeFor(page, size);

  const supabase = await createClient();
  const filters = { start, end, classes, view, q: query, sampleOnly };
  const isAdmin = session.role === "admin";

  // The strip breaks down BY class, so it deliberately ignores the class chips
  // (applying them would zero every column the reader is trying to compare)
  // while tracking the date range and the deleted view. Admin-only: the strip
  // is not rendered for anyone else, so the RPC is skipped for them too.
  // Same dates one year earlier, for the dropdown's comparison line — only
  // for a closed range (there is no "last year" of an open-ended one).
  const prior = start && end ? priorYearRange(start, end) : null;
  const [{ rows, count }, summaryRes, priorRes] = await Promise.all([
    fetchArchiveWindow(supabase, filters, sort, offset, size),
    isAdmin
      ? supabase.rpc("visits_classification_summary", {
          p_start: start || undefined,
          p_end: end || undefined,
          p_deleted: view,
        })
      : Promise.resolve({ data: null, error: null }),
    isAdmin && prior
      ? supabase.rpc("visits_classification_summary", {
          p_start: prior.start,
          p_end: prior.end,
          p_deleted: view,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const summary = summariseClasses(summaryRes.data);
  const totals = summaryTotals(summary);
  const priorSummary = prior && !priorRes.error ? summariseClasses(priorRes.data) : null;

  // Paging counts VISITS, not folded encounters — a distinct count over
  // coalesce(visit_group_id, id) isn't expressible through PostgREST. Split
  // encounters only exist when one counter order mixes doctor and lab lines,
  // so this is at most a row or two of drift per page; the header says
  // "visits", which stays true either way.
  const totalPages = pageCount(count, size);
  const safePage = Math.min(page, totalPages);
  const splitCount = rows.filter((r) => r.split).length;

  const isDefaultSort = sort.key === DEFAULT_ARCHIVE_SORT.key && sort.dir === DEFAULT_ARCHIVE_SORT.dir;

  // Every filter/sort/size param at its default is omitted, so page 1 with the
  // default sort and size stays the bare `/staff/visits` URL. `page` is
  // deliberately NOT here — every call site below states its own page
  // (`null` to reset to 1, or an explicit number), same convention as
  // `/staff/patients`.
  const baseParams: Record<string, string | null> = {
    q: query || null,
    start: start || null,
    end: end || null,
    kind: serialiseVisitClasses(classes) || null,
    view: view === "active" ? null : view,
    sample: sampleOnly ? "1" : null,
    rev: revenueOpen ? "1" : null,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
  };

  function buildHref(overrides: Record<string, string | null>): string {
    return buildListHref(BASE_PATH, baseParams, overrides);
  }

  const sortHref = (key: ArchiveSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === DEFAULT_ARCHIVE_SORT.key && next.dir === DEFAULT_ARCHIVE_SORT.dir;
    // Any change to sort resets to page 1 — staying on page 7 of a result
    // set that just reordered is a blank screen with no explanation.
    return buildHref({
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: ArchiveSortColumn, align?: "right") => (
    <SortableTh
      key={key}
      label={SORT_LABEL[key]}
      href={sortHref(key)}
      state={ariaSortFor(sort, key)}
      align={align}
    />
  );

  // Same sort/dir as the table, so the file always matches what's on screen —
  // fetchArchiveAll (the CSV's query) threads it into the identical
  // archiveOrderPlan `fetchArchiveWindow` uses here.
  const exportQs = new URLSearchParams();
  if (query) exportQs.set("q", query);
  if (start) exportQs.set("start", start);
  if (end) exportQs.set("end", end);
  if (serialiseVisitClasses(classes)) {
    exportQs.set("kind", serialiseVisitClasses(classes));
  }
  if (view !== "active") exportQs.set("view", view);
  if (sampleOnly) exportQs.set("sample", "1");
  if (!isDefaultSort) {
    exportQs.set("sort", sort.key);
    exportQs.set("dir", sort.dir);
  }
  const exportHref = `/api/admin/visits.csv${exportQs.toString() ? `?${exportQs}` : ""}`;

  const rangeLabel =
    start && end
      ? `${start} → ${end}`
      : start
        ? `from ${start}`
        : end
          ? `up to ${end}`
          : "all dates";

  const chipLabel =
    classes.size === 0 || classes.size === VISIT_CLASSES.length
      ? null
      : VISIT_CLASSES.filter((c) => classes.has(c))
          .map((c) => VISIT_CLASS_LABEL[c])
          .join(" + ");

  const revenuePresets = buildRevenuePresets(todayManilaISODate());
  const activePreset = matchRevenuePreset(revenuePresets, start, end);
  const revenueRangeLabel = [
    activePreset && activePreset.key !== "all" ? activePreset.label : null,
    rangeLabel,
    view !== "active" ? view : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hasFilters = Boolean(
    query || start || end || chipLabel || view !== "active" || sampleOnly,
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Visit Records"
        subtitle={
          <>
            {count} visit{count === 1 ? "" : "s"} · {rangeLabel}
            {chipLabel ? ` · ${chipLabel}` : null}
            {view !== "active" ? ` · ${VISIT_VIEW_LABEL[view]}` : null}
            {sampleOnly ? " · Sample visits only" : null}
            {splitCount > 0
              ? ` · ${splitCount} split visit${splitCount === 1 ? "" : "s"} shown as one row`
              : null}
          </>
        }
      />

      <div className="mb-6">
        <VisitsSearchInput initialQuery={query} />
      </div>

      {/* The classification chips + export button used to live in PageHeader's
          `actions` slot, sharing its `flex flex-wrap items-start
          justify-between` row with the subtitle above. That subtitle's length
          changes constantly (the count, the date range, the chip echo, the
          view label, "N split visits shown as one row"), so a longer subtitle
          pushed this row onto a new line and a shorter one pulled it back up
          beside the title — the chips and the export button visibly jumped
          position on every filter change. Standalone below the header, they
          sit in the same place regardless of what the subtitle says — the
          same fix the lab queue (`queue/page.tsx`) applies to its filter bar. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Filter by classification"
          className="flex flex-wrap gap-2 text-sm"
        >
          <FilterTab
            href={buildHref({ kind: null, page: null })}
            label="All"
            active={classes.size === 0}
          />
          {VISIT_CLASSES.map((c) => (
            <FilterTab
              key={c}
              // Chips are additive — each toggles itself in or out.
              href={buildHref({
                kind: serialiseVisitClasses(toggleVisitClass(classes, c)) || null,
                page: null,
              })}
              label={VISIT_CLASS_LABEL[c]}
              active={classes.has(c)}
            />
          ))}
        </nav>
        {isAdmin ? <ExportCsvLink href={exportHref} /> : null}
      </div>

      <div className="mb-6"><VisitsTabs /></div>

      {isAdmin ? (
        <RevenueByClass
          rows={summary}
          totals={totals}
          rangeLabel={revenueRangeLabel}
          open={revenueOpen}
          error={Boolean(summaryRes.error)}
          selected={classes}
          // Each preset sets the page's own date range, so the list below
          // follows it too — one click instead of two date pickers + Apply.
          presets={revenuePresets}
          activePreset={activePreset?.key}
          presetHref={(p) =>
            buildHref({ start: p.start || null, end: p.end || null, page: null, rev: "1" })
          }
          cardHref={(c) =>
            buildHref({
              kind: serialiseVisitClasses(toggleVisitClass(classes, c)) || null,
              page: null,
              rev: "1",
            })
          }
          prior={
            priorSummary ? { rows: priorSummary, totals: summaryTotals(priorSummary) } : null
          }
          pnlHref={start && end ? `/staff/admin/operations/expenses?from=${start}&to=${end}` : null}
          notes={
            query ? (
              <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
                Revenue overview includes all patients and visit numbers in this date range.
              </p>
            ) : null
          }
        />
      ) : null}

      <form
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
        action="/staff/visits"
      >
        {query ? <input type="hidden" name="q" value={query} /> : null}
        {/* Keep the open chips + view when dates are applied. */}
        {serialiseVisitClasses(classes) ? (
          <input type="hidden" name="kind" value={serialiseVisitClasses(classes)} />
        ) : null}
        {view !== "active" ? <input type="hidden" name="view" value={view} /> : null}
        {sampleOnly ? <input type="hidden" name="sample" value="1" /> : null}
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Start date
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            End date
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        <div className="flex items-end gap-2">
          <span className="sr-only" id="view-label">
            Show deleted visits
          </span>
          <nav aria-labelledby="view-label" className="flex gap-1 text-sm">
            {VISIT_VIEWS.map((v) => (
              <FilterTab
                key={v}
                href={buildHref({ view: v === "active" ? null : v, page: null })}
                label={VISIT_VIEW_LABEL[v]}
                active={view === v}
              />
            ))}
          </nav>
          <FilterTab
            href={buildHref({ sample: sampleOnly ? null : "1", page: null })}
            label="Sample visits"
            active={sampleOnly}
          />
        </div>
        {hasFilters ? (
          <Link
            href="/staff/visits"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            Clear filters
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <Panel className="p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          {sampleOnly
            ? "No sample visits in this range."
            : view === "deleted"
            ? "No deleted visits in this range."
            : chipLabel
              ? `No ${chipLabel.toLowerCase()} visits in this range.`
              : "No visits in this range."}
        </Panel>
      ) : (
        <>
          {/* Desktop table */}
          <Panel className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("visit_date")}
                  {th("visit_number")}
                  {th("patient_last_name")}
                  <PlainTh label="Classification" />
                  {/* Not sortable: the count comes from a second query run
                      after this window is fetched (package components can't
                      be counted from the visits row), so it can't be
                      expressed in the same .order() call. */}
                  <PlainTh label="Tests" align="right" />
                  {th("total_php", "right")}
                  {th("paid_php", "right")}
                  {/* Not sortable: aggregated from the payments join, not a
                      single visits column. */}
                  <PlainTh label="Method" />
                  {th("payment_status")}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.key}
                    className={`border-t border-[color:var(--color-brand-bg-mid)] ${
                      r.deleted ? "bg-[color:var(--color-brand-bg)]/60" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {manilaDate(r.visitDate)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <VisitNumbers row={r} />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/patients/${r.patient.id}`}
                        className="text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {formatPatientName(r.patient)}
                      </Link>{" "}
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        ({r.patient.drm_id})
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ClassificationBadges classes={r.classes} />
                    </td>
                    <td className="px-4 py-3 text-right">{r.testCount}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.total)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.paid)}
                      {r.waived > 0 ? (
                        <div className="font-sans text-xs text-[color:var(--color-brand-text-soft)]">
                          {PHP.format(r.waived)} waived
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.methods}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.status] ?? ""}`}
                      >
                        {paymentStatusLabel(r.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {/* Mobile card list */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => (
              <article
                key={r.key}
                className={`rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 ${
                  r.deleted ? "opacity-80" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs">
                    <VisitNumbers row={r} />
                  </span>
                  <span
                    className={`inline-block shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.status] ?? ""}`}
                  >
                    {paymentStatusLabel(r.status)}
                  </span>
                </div>
                <Link
                  href={`/staff/patients/${r.patient.id}`}
                  className="mt-1 block font-medium text-[color:var(--color-brand-navy)] hover:underline"
                >
                  {formatPatientName(r.patient)}
                </Link>
                <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {r.patient.drm_id} · {manilaDate(r.visitDate)} · {r.testCount} test
                  {r.testCount === 1 ? "" : "s"}
                </div>
                <div className="mt-2">
                  <ClassificationBadges classes={r.classes} />
                </div>
                <div className="mt-2 flex justify-between text-xs">
                  <span>
                    Total:{" "}
                    <span className="font-mono">{PHP.format(r.total)}</span>
                  </span>
                  <span>
                    Paid: <span className="font-mono">{PHP.format(r.paid)}</span>
                    {r.waived > 0 ? (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        {" "}· {PHP.format(r.waived)} waived
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  {r.methods}
                </div>
              </article>
            ))}
          </div>

          <ListPagination
            page={safePage}
            pageCount={totalPages}
            total={count}
            size={size}
            prevHref={safePage > 1 ? buildHref({ page: safePage - 1 > 1 ? String(safePage - 1) : null }) : null}
            nextHref={safePage < totalPages ? buildHref({ page: String(safePage + 1) }) : null}
            sizeOptions={PAGE_SIZES.map((s) => ({
              size: s,
              // Changing the page size resets to page 1 — same reasoning as sort.
              href: buildHref({
                size: s === DEFAULT_PAGE_SIZE ? null : String(s),
                page: null,
              }),
            }))}
            noun="visit"
          />
        </>
      )}
    </div>
  );
}

/** Visit numbers for a row — both halves when split, plus a receipt shortcut. */
function VisitNumbers({ row }: { row: ArchiveRow }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {row.members.map((m, i) => (
          <span key={m.id} className="whitespace-nowrap">
            {i > 0 ? (
              <span
                aria-hidden="true"
                className="mr-1.5 text-[color:var(--color-brand-text-soft)]"
              >
                +
              </span>
            ) : null}
            <Link
              href={`/staff/visits/${m.id}`}
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              {visitNo(m.visit_number)}
            </Link>
          </span>
        ))}
      </span>
      {row.split && row.groupId ? (
        <span className="mt-1 block font-sans text-[10px] font-semibold uppercase tracking-wider">
          <span className="text-[color:var(--color-brand-text-soft)]">
            Split visit
          </span>
          {/* Nothing left to print once every surviving half is a
              consultation (item 1) — don't offer a dead link. */}
          {row.printsReceipt ? (
            <>
              <span className="text-[color:var(--color-brand-text-soft)]"> · </span>
              <Link
                href={`/staff/visits/group/${row.groupId}/receipt`}
                className="text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Combined receipt
              </Link>
            </>
          ) : null}
        </span>
      ) : null}
      {row.sample ? (
        <span className="mt-1 block">
          <SampleBadge size="compact" />
        </span>
      ) : null}
      {row.deleted ? (
        <span
          className="mt-1 block font-sans text-[10px] font-semibold uppercase tracking-wider text-red-700"
          title={row.deleteReason ?? undefined}
        >
          Deleted
        </span>
      ) : null}
    </>
  );
}

function ClassificationBadges({ classes }: { classes: VisitClass[] }) {
  if (classes.length === 0) {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">—</span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {classes.map((c) => (
        <span
          key={c}
          className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${CLASS_BADGE[c]}`}
        >
          {VISIT_CLASS_LABEL[c]}
        </span>
      ))}
    </span>
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
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
