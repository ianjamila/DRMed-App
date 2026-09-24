import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import {
  DEFAULT_EMAIL_LOG_SORT,
  EMAIL_LOG_SORT_COLUMNS,
  fetchEmailLog,
  PAGE_SIZE,
  type EmailLogSortColumn,
} from "@/lib/emails-log/query";
import type { EmailStatus, EmailType } from "@/lib/emails-log/types";
import { manilaDateTime } from "@/lib/dates/manila";
import {
  ariaSortFor,
  buildListHref,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

const BASE_PATH = "/staff/admin/emails-sent";

export const metadata = { title: "Emails Sent" };

const STATUS_STYLE: Record<EmailStatus, string> = {
  sent: "bg-emerald-100 text-emerald-900",
  failed: "bg-rose-100 text-rose-900",
  no_email: "bg-amber-100 text-amber-900",
  bulk: "bg-slate-200 text-slate-700",
};

const TYPE_OPTIONS: { value: EmailType; label: string }[] = [
  { value: "result", label: "Result ready" },
  { value: "booking", label: "Booking confirmation" },
  { value: "reminder", label: "Appointment reminder" },
  { value: "newsletter", label: "Newsletter" },
  { value: "registration_new", label: "Registration welcome" },
  { value: "registration_existing", label: "Registration (existing)" },
  { value: "contact_alert", label: "Website message alert" },
  { value: "booking_alert", label: "Online booking alert" },
];

const STATUS_OPTIONS: { value: EmailStatus; label: string }[] = [
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "no_email", label: "No email on file" },
];

const VALID_TYPES = new Set(TYPE_OPTIONS.map((t) => t.value));
const VALID_STATUS = new Set(STATUS_OPTIONS.map((s) => s.value));

interface Props {
  searchParams: Promise<{
    type?: string;
    status?: string;
    drm?: string;
    since?: string;
    until?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function EmailsSentPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;

  const type =
    params.type && VALID_TYPES.has(params.type as EmailType)
      ? (params.type as EmailType)
      : null;
  const status =
    params.status && VALID_STATUS.has(params.status as EmailStatus)
      ? (params.status as EmailStatus)
      : null;
  const sort = parseSort(
    params.sort,
    params.dir,
    EMAIL_LOG_SORT_COLUMNS,
    DEFAULT_EMAIL_LOG_SORT,
  );
  const size = parsePageSize(params.size, PAGE_SIZE);
  const page = parsePage(params.page);

  const { entries, total, failures7d, since7Date, resolvedDrmId, drmNoMatch } =
    await fetchEmailLog({
      type,
      status,
      drmId: params.drm ?? null,
      since: params.since ?? null,
      until: params.until ?? null,
      sort,
      page,
      size,
    });

  const totalPages = pageCount(total, size);

  // Params at their default are omitted, so the log's own URL stays bare.
  const isDefaultSort =
    sort.key === DEFAULT_EMAIL_LOG_SORT.key && sort.dir === DEFAULT_EMAIL_LOG_SORT.dir;
  const baseParams: Record<string, string | null> = {
    type,
    status,
    drm: params.drm ?? null,
    since: params.since ?? null,
    until: params.until ?? null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZE ? null : String(size),
  };

  function buildHref(overrides: Record<string, string | null>): string {
    return buildListHref(BASE_PATH, baseParams, overrides);
  }

  const sortHref = (key: EmailLogSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === DEFAULT_EMAIL_LOG_SORT.key && next.dir === DEFAULT_EMAIL_LOG_SORT.dir;
    // A re-sort goes back to page 1 — page 7 of a set that just reordered is
    // a screenful of unrelated rows.
    return buildHref({
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: EmailLogSortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  const hasFilter = Boolean(
    type || status || params.drm || params.since || params.until,
  );
  const exportQs = (() => {
    const sp = new URLSearchParams();
    if (type) sp.set("type", type);
    if (status) sp.set("status", status);
    if (params.drm) sp.set("drm", params.drm);
    if (params.since) sp.set("since", params.since);
    if (params.until) sp.set("until", params.until);
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  })();

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Emails Sent
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Every transactional email the system sent — result alerts, booking
          confirmations, reminders, newsletters, and registration welcomes.
          Read-only, reconstructed from the audit log.
        </p>
      </header>

      {failures7d > 0 && status !== "failed" ? (
        <Link
          href={`/staff/admin/emails-sent?status=failed&since=${since7Date}`}
          className="mb-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900 hover:bg-rose-100"
        >
          <strong>{failures7d}</strong> failed send
          {failures7d === 1 ? "" : "s"} in the last 7 days — view failures →
        </Link>
      ) : null}

      {/* A GET form submits only the fields it carries, so without these the
          Filter button would silently reset the reader's sort and page size. */}
      <form className="mb-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-6">
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === PAGE_SIZE ? null : (
          <input type="hidden" name="size" value={String(size)} />
        )}
        <select
          name="type"
          defaultValue={type ?? ""}
          aria-label="Email type"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none lg:col-span-2"
        >
          <option value="">All types</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label="Status"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          name="drm"
          defaultValue={params.drm ?? ""}
          placeholder="DRM-ID · e.g. DRM-0042"
          aria-label="Patient DRM-ID"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <div className="grid grid-cols-2 gap-2 lg:col-span-2">
          <input
            type="date"
            name="since"
            defaultValue={params.since ?? ""}
            aria-label="From date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
          <input
            type="date"
            name="until"
            defaultValue={params.until ?? ""}
            aria-label="To date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:col-span-6">
          <button
            type="submit"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Filter
          </button>
          {hasFilter ? (
            // Clears the filters, keeps the view: sort and page size survive.
            <Link
              href={buildHref({
                type: null,
                status: null,
                drm: null,
                since: null,
                until: null,
                page: null,
              })}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
            >
              Clear
            </Link>
          ) : null}
          <Link
            href={buildHref({ status: "failed", page: null })}
            className="rounded-md border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50"
          >
            Failures only
          </Link>
          <div className="ml-auto">
            <ExportCsvLink href={`/staff/admin/emails-sent/export${exportQs}`} />
          </div>
        </div>
      </form>

      {drmNoMatch ? (
        <p className="mb-3 text-xs text-amber-700" role="alert">
          No patient with DRM-ID {params.drm}.
        </p>
      ) : resolvedDrmId ? (
        <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Filtered to <strong>{resolvedDrmId}</strong>.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("created_at", "Sent")}
              {th("action", "Type")}
              <PlainTh label="Recipient" />
              <PlainTh label="Email" />
              <PlainTh label="Status" />
              <PlainTh label="Details" />
              <PlainTh label="Resource" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No emails match these filters.
                </td>
              </tr>
            ) : (
              entries.map((e) => {
                const resource =
                  e.type === "result" && e.visitId
                    ? { href: `/staff/visits/${e.visitId}`, label: "Visit" }
                    : e.type === "booking" || e.type === "reminder"
                      ? { href: "/staff/appointments", label: "Appointment" }
                      : e.type === "newsletter"
                        ? { href: "/staff/admin/newsletter", label: "Campaign" }
                        : null;
                return (
                  <tr key={e.id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-mid)]">
                      {manilaDateTime(e.sentAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.typeLabel}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {e.type === "newsletter" ? (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          All subscribers{e.bulk ? ` (${e.bulk.attempted})` : ""}
                        </span>
                      ) : e.patientId ? (
                        <Link
                          href={`/staff/patients/${e.patientId}`}
                          className="text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {e.recipientName ?? "(no name)"}
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">—</span>
                      )}
                      {e.recipientDrmId ? (
                        <span className="ml-1 text-xs text-[color:var(--color-brand-text-soft)]">
                          ({e.recipientDrmId})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.recipientEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[e.status]}`}
                      >
                        {e.bulk
                          ? `${e.bulk.delivered} sent · ${e.bulk.failed} failed`
                          : e.statusLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.detail ? <span>{e.detail}</span> : null}
                      {e.resendId ? (
                        <span className="mt-0.5 block font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                          {e.resendId}
                        </span>
                      ) : null}
                      {e.reviewCtaShown ? (
                        <span className="mt-0.5 inline-block rounded-md bg-cyan-100 px-2 py-0.5 text-xs font-semibold text-cyan-900">
                          Review ask ✓
                        </span>
                      ) : null}
                      {!e.detail && !e.resendId && !e.reviewCtaShown ? "—" : null}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {resource ? (
                        <Link
                          href={resource.href}
                          className="text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {resource.label}
                        </Link>
                      ) : (
                        "—"
                      )}
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
            ? buildHref({ page: page - 1 > 1 ? String(page - 1) : null })
            : null
        }
        nextHref={page < totalPages ? buildHref({ page: String(page + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: buildHref({
            size: s === PAGE_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="email"
      />
    </div>
  );
}
