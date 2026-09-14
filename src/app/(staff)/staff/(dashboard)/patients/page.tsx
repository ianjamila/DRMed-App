import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { RegistrationLinkButton } from "@/components/staff/registration-link-button";
import { formatPhoneLocal } from "@/lib/format/phone";
import { patientSearchOrClauses } from "@/lib/patients/search";
import { formatPatientName } from "@/lib/patients/format-name";
import {
  PRE_REGISTERED_LABEL_VERIFY,
  PRE_REGISTERED_BADGE_CLASS,
} from "@/lib/patients/labels";
import { PatientsSearchInput } from "./search-input";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
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
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import { manilaDate } from "@/lib/dates/manila";

export const metadata = {
  title: "Patients — staff",
};

interface SearchProps {
  searchParams: Promise<{
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

const BASE_PATH = "/staff/patients";

// This page's default page size has always been 50 (not the shared
// PAGE_SIZES default of 25) — keep it so existing bookmarks/behaviour don't
// change for reception.
const PAGE_SIZE_DEFAULT = 50;

// Sortable columns for the patients directory. `parseSort` requires this
// exact allow-list — it's a security boundary because the value reaches a
// PostgREST `.order()`; never widen it to a raw search param.
const SORTABLE_COLUMNS = [
  "drm_id",
  "last_name",
  "phone",
  "email",
  "referral_source_label",
  "last_visit_date",
  "created_at",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "created_at", dir: "desc" };

// Nullable columns where "no value" should sink to the bottom regardless of
// sort direction — 2,758 patients have no referral source and many have
// never visited, so a plain ASC/DESC would otherwise surface those blanks
// first on one of the two directions.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["referral_source_label", "last_visit_date"]);

/**
 * Row shape for `public.v_patients_directory` (migration 0143). The view
 * hasn't been applied locally yet, so it isn't in the generated
 * `src/types/database.ts` — the `.from()` call is cast past the generated
 * table/view union and the real shape is restored with `.returns<>()`
 * below. Remove the cast once `npm run db:types` knows about the view.
 */
interface PatientDirectoryRow {
  id: string;
  drm_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  phone: string | null;
  email: string | null;
  pre_registered: boolean;
  created_at: string;
  referral_source: string | null;
  referral_source_label: string | null;
  last_visit_date: string | null;
}

async function search(
  query: string | undefined,
  sort: SortSpec<SortColumn>,
  page: number,
  size: number,
) {
  const supabase = await createClient();
  const [from, to] = rangeFor(page, size);

  let q = supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- v_patients_directory (migration 0143) isn't in the generated Database type yet; row shape is restored below via .returns<PatientDirectoryRow[]>()
    .from("v_patients_directory" as any)
    .select(
      "id, drm_id, first_name, middle_name, last_name, phone, email, pre_registered, created_at, referral_source, referral_source_label, last_visit_date",
      { count: "exact" },
    );

  // Token-based: every word must match some field (any order), so "Jamila, Ian"
  // finds a patient stored as first_name="Ian", last_name="Jamila". The view
  // exposes every column this touches (drm_id/first_name/middle_name/last_name/
  // phone/email), so the same clauses apply unchanged.
  for (const clause of patientSearchOrClauses(query)) {
    q = q.or(clause);
  }

  q = q.order(sort.key, {
    ascending: sort.dir === "asc",
    ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
  });
  // Tie-break on id — without a total order, .range() can drop or repeat
  // rows across pages, and with 7,057 patients that's a silent correctness
  // bug, not a cosmetic one.
  q = q.order("id", { ascending: true }).range(from, to);

  const { data, error, count } = await q.returns<PatientDirectoryRow[]>();
  if (error) {
    console.error("patients search failed", error);
    return { rows: [], total: 0 };
  }
  return { rows: data ?? [], total: count ?? 0 };
}

export default async function PatientsPage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const query = params.q ?? "";
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, PAGE_SIZE_DEFAULT);
  const page = parsePage(params.page);
  const { rows: patients, total } = await search(query, sort, page, size);
  const totalPages = pageCount(total, size);

  // Same derivation the Appointments page uses, so the QR points at whatever
  // host reception actually reached the app on (prod, preview or localhost)
  // rather than a hardcoded domain that would be wrong on two of the three.
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const registerUrl = `${proto}://${host}/register?src=staff_qr`;

  // Params at their default are omitted so page 1 with the default sort and
  // size stays the bare /staff/patients URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    q: query || null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZE_DEFAULT ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // Any change to sort resets to page 1 — staying on page 7 of a result
    // set that just reordered is a blank screen with no explanation.
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Patients"
        subtitle="Search by DRM-ID, name, phone, or email — filters as you type."
        actions={
          <>
            {/* Same QR reception already has on Appointments: hand the phone
                to the patient and let them self-register. This is the other
                page reception stands on when someone walks up unregistered,
                so the shortcut belongs here too. */}
            <RegistrationLinkButton url={registerUrl} />
            <Link
              href="/staff/patients/new"
              className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
            >
              + New patient
            </Link>
          </>
        }
      />

      <div className="mb-6">
        <PatientsSearchInput initialQuery={query} />
      </div>

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("drm_id", "DRM-ID")}
              {th("last_name", "Name")}
              {th("phone", "Phone")}
              {th("email", "Email")}
              {th("referral_source_label", "Source")}
              {th("last_visit_date", "Last visit")}
              {th("created_at", "Registered")}
              <PlainTh label="Status" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {patients.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No patients match.
                </td>
              </tr>
            ) : (
              patients.map((p) => {
                const displayName = formatPatientName(p);
                return (
                  <tr
                    key={p.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                      <Link
                        href={`/staff/patients/${p.id}`}
                        className="hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {p.drm_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/patients/${p.id}`}
                        className={
                          !displayName
                            ? "italic text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-cyan)]"
                            : "font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        }
                      >
                        {displayName || "(no name on file)"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {p.phone ? formatPhoneLocal(p.phone) : "—"}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {p.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {p.referral_source_label ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manilaDate(p.last_visit_date)}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manilaDate(p.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      {p.pre_registered ? (
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${PRE_REGISTERED_BADGE_CLASS}`}
                        >
                          {PRE_REGISTERED_LABEL_VERIFY}
                        </span>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          Verified
                        </span>
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
          // Changing the page size resets to page 1 — same reasoning as sort.
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === PAGE_SIZE_DEFAULT ? null : String(s),
            page: null,
          }),
        }))}
        noun="patient"
      />
    </div>
  );
}
