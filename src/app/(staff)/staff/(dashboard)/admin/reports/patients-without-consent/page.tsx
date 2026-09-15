import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import {
  comparePatientsWithoutConsent,
  loadPatientsWithoutConsent,
  patientsWithoutConsentCsvHref,
  PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT,
  PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS,
  type PatientsWithoutConsentSortColumn,
} from "@/lib/reports/patients-without-consent";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  PRE_REGISTERED_LABEL,
  PRE_REGISTERED_BADGE_CLASS,
} from "@/lib/patients/labels";
import { formatPatientName } from "@/lib/patients/format-name";
import { manilaDate } from "@/lib/dates/manila";
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

export const metadata = { title: "Patients Without Consent" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/reports/patients-without-consent";

interface SearchProps {
  searchParams: Promise<{
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function PatientsWithoutConsentPage({
  searchParams,
}: SearchProps) {
  await requireAdminStaff();
  const admin = createAdminClient();
  const sp = await searchParams;

  const sort = parseSort(
    sp.sort,
    sp.dir,
    PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS,
    PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT,
  );
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const {
    rows: all,
    visitCount,
    lastVisit,
    truncated: candidatesIncomplete,
  } = await loadPatientsWithoutConsent(admin, REPORT_EXPORT_MAX_ROWS);

  const total = all.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  // Sort the FULL candidate set, then slice — the pager's trim now stands in
  // for what used to be `displayLimit` (see the loader's doc comment). This
  // keeps the M15 invariant alive: the comparator always runs over the whole
  // sorted-before-anything-is-cut set, so which page a patient lands on is
  // never an artifact of the raw `created_at desc` fetch order.
  const rows = [...all]
    .sort((a, b) => comparePatientsWithoutConsent(a, b, sort, visitCount, lastVisit))
    .slice(from, to + 1);

  // Params at their default are omitted so the plain, unfiltered URL stays
  // bare — this page has no filters, only sort/page/size.
  const isDefaultSort =
    sort.key === PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT.key &&
    sort.dir === PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  // Every header keeps sort/size and resets to page 1 — changing the sort
  // while sitting on page 9 of a set whose ranking just changed is a blank
  // screen with no explanation.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: PatientsWithoutConsentSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT.key &&
      next.dir === PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT.dir;
    return href({
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
    });
  };

  const th = (
    key: PatientsWithoutConsentSortColumn,
    label: string,
    align?: "left" | "right",
  ) => (
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
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Patients Without Consent
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Active patients with no data-privacy consent on file (RA 10173). Once
          the consent gate is switched ON, results cannot be released for anyone
          on this list — clear it to zero first. Capture consent from each
          patient&apos;s record (printed form, on-screen signature, or the
          patient accepting the notice in their portal).
        </p>
        <p className="mt-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {total} {total === 1 ? "patient" : "patients"} without consent.{" "}
          <Link
            href="/staff/admin/settings/consent-gate"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Consent-gate settings →
          </Link>
        </p>
        <div className="mt-3">
          <ExportCsvLink href={patientsWithoutConsentCsvHref()} />
        </div>
      </header>

      {candidatesIncomplete ? (
        <p className="mt-4 text-xs font-semibold text-red-700">
          TRUNCATED — more than {REPORT_EXPORT_MAX_ROWS.toLocaleString()}{" "}
          patients matched; the list below (and its ordering) is incomplete.
          Use the CSV export or narrow the underlying data.
        </p>
      ) : null}

      <Panel className="mt-6 overflow-hidden">
        {total === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            Every active patient has consent on file. Safe to enable the consent
            gate.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("patient", "Patient")}
                  {th("drm_id", "DRM-ID")}
                  {th("visits", "Visits", "right")}
                  {th("last_visit", "Last visit")}
                  {th("contact", "Contact on file")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((p) => {
                  const name = formatPatientName(p) || "(no name on file)";
                  const last = lastVisit.get(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/patients/${p.id}#consent`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {name}
                        </Link>
                        {p.pre_registered ? (
                          <span
                            className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${PRE_REGISTERED_BADGE_CLASS}`}
                          >
                            {PRE_REGISTERED_LABEL}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {p.drm_id}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {visitCount.get(p.id) ?? 0}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {last ? (
                          manilaDate(last)
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            No visits
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-1.5">
                          <ContactPill present={!!p.phone} label="Phone" />
                          <ContactPill present={!!p.email} label="Email" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 ? (
          <div className="px-4 py-3">
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
                  ? buildListHref(BASE_PATH, baseParams, {
                      page: String(page + 1),
                    })
                  : null
              }
              sizeOptions={PAGE_SIZES.map((s) => ({
                size: s,
                href: href({ size: s === DEFAULT_PAGE_SIZE ? null : String(s) }),
              }))}
              noun="patient"
            />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function ContactPill({ present, label }: { present: boolean; label: string }) {
  return present ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
      {label}
    </span>
  ) : (
    <span className="rounded-full bg-[color:var(--color-brand-bg-mid)] px-2 py-0.5 text-[color:var(--color-brand-text-soft)]">
      No {label.toLowerCase()}
    </span>
  );
}
