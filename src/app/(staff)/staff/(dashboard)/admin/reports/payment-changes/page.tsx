import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { manilaDateTime, todayManilaISODate } from "@/lib/dates/manila";
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
import { paymentMethodLabel, PAYMENT_FATE_LABEL } from "@/lib/visits/payment-history";
import {
  comparePaymentChanges,
  loadPaymentChanges,
  parsePaymentChangesParams,
  PAYMENT_CHANGES_DEFAULT_SORT,
  PAYMENT_CHANGES_SORTABLE_COLUMNS,
  paymentChangeOutcome,
  paymentChangesCsvHref,
  type PaymentChangeKind,
  type PaymentChangesSortColumn,
} from "@/lib/reports/payment-changes";

export const metadata = { title: "Payment Changes" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/reports/payment-changes";

const KIND_OPTIONS: { value: PaymentChangeKind; label: string }[] = [
  { value: "all", label: "All changes" },
  { value: "deleted", label: "Deleted" },
  { value: "edited", label: "Edited" },
  { value: "moved", label: "Moved" },
];

const FATE_STYLE: Record<string, string> = {
  deleted: "bg-red-100 text-red-900",
  edited: "bg-amber-100 text-amber-900",
  moved: "bg-sky-100 text-sky-900",
};

interface SearchProps {
  searchParams: Promise<{
    start?: string;
    end?: string;
    kind?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function PaymentChangesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const params = parsePaymentChangesParams(sp, todayISO);
  const { start, end, kind } = params;
  const sort = parseSort(sp.sort, sp.dir, PAYMENT_CHANGES_SORTABLE_COLUMNS, PAYMENT_CHANGES_DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  // Same ceiling as the CSV walk, so the pager and the tiles are exact for any
  // window under it (see undone-releases/page.tsx).
  const admin = createAdminClient();
  const { entries, summary, truncated } = await loadPaymentChanges(admin, params, REPORT_EXPORT_MAX_ROWS);

  const total = entries.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  const rows = [...entries].sort((a, b) => comparePaymentChanges(a, b, sort)).slice(from, to + 1);

  const isDefaultSort =
    sort.key === PAYMENT_CHANGES_DEFAULT_SORT.key && sort.dir === PAYMENT_CHANGES_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    start,
    end,
    kind: kind === "all" ? null : kind,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });
  const sortHref = (key: PaymentChangesSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === PAYMENT_CHANGES_DEFAULT_SORT.key && next.dir === PAYMENT_CHANGES_DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };
  const th = (key: PaymentChangesSortColumn, label: string, align?: "left" | "right") => (
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
          Payment Changes
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Every payment that was deleted, edited (wrong method, amount or
          reference) or moved to another visit — who changed it, when, why, and
          what it became. Nothing is ever erased: a deleted, re-keyed or moved
          payment stays on its visit under <b>Deleted, edited &amp; moved
          payments</b>, and a reference or notes fix keeps its before and after
          here.
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
            Changed from
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
            htmlFor="kind"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Change
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue={kind}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {/* A plain-GET form submits only what it carries: keep sort + size. */}
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === DEFAULT_PAGE_SIZE ? null : <input type="hidden" name="size" value={size} />}
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        <ExportCsvLink href={paymentChangesCsvHref(params)} />
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Deleted"
          value={String(summary.deleted)}
          hint={`${formatPhp(summary.deletedPhp)} taken off visits — ${start} → ${end}`}
          tone={summary.deleted > 0 ? "warn" : "ok"}
        />
        <SummaryTile label="Edited" value={String(summary.edited)} hint="Wrong method, amount or reference fixed" />
        <SummaryTile label="Moved" value={String(summary.moved)} hint="Filed against the wrong visit" />
        <SummaryTile
          label="Most changes by"
          value={summary.topActor ? summary.topActor.name : "—"}
          hint={
            summary.topActor
              ? `${summary.topActor.count} of ${summary.total} changes`
              : "No changes in this window"
          }
        />
      </div>

      {truncated ? (
        <p className="mb-3 text-xs text-amber-700">
          Showing the most recent {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} — narrow the range to see the rest.
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No payments were {kind === "all" ? "changed" : kind} in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("when", "When")}
                  {th("change", "Change")}
                  {th("patient", "Patient · Visit")}
                  {th("amount", "Payment", "right")}
                  <PlainTh label="Now" />
                  {th("by", "Changed by")}
                  <PlainTh label="Reason" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {manilaDateTime(e.changedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${FATE_STYLE[e.fate] ?? ""}`}>
                        {PAYMENT_FATE_LABEL[e.fate]}
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
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        <Link href={`/staff/visits/${e.visitId}`} className="hover:underline">
                          #{e.visitNumber ?? "—"}
                        </Link>
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold">{formatPhp(e.amountPhp)}</span>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {paymentMethodLabel(e.method)}
                        {e.reference ? ` · ${e.reference}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {e.fate === "moved" && e.replacement ? (
                        <Link
                          href={`/staff/visits/${e.replacement.visitId}`}
                          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          {paymentChangeOutcome(e)}
                        </Link>
                      ) : (
                        <span className={e.fate === "deleted" ? "text-[color:var(--color-brand-text-soft)]" : ""}>
                          {paymentChangeOutcome(e)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{e.byName ?? "—"}</td>
                    <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.reason ?? "—"}
                    </td>
                  </tr>
                ))}
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
            ? buildListHref(BASE_PATH, baseParams, { page: page - 1 > 1 ? String(page - 1) : null })
            : null
        }
        nextHref={page < totalPages ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: href({ size: s === DEFAULT_PAGE_SIZE ? null : String(s) }),
        }))}
        noun="change"
        plural="changes"
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
  const accent = tone === "warn" ? "before:bg-amber-400" : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">{label}</p>
      <p className="mt-2 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{hint}</p> : null}
    </article>
  );
}
