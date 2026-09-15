import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Panel } from "@/components/ui/panel";
import { manilaDateTime } from "@/lib/dates/manila";
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

export const metadata = {
  title: "Audit Log — staff",
};

const ACTOR_TYPE_STYLE: Record<string, string> = {
  staff: "bg-sky-100 text-sky-900",
  patient: "bg-emerald-100 text-emerald-900",
  system: "bg-slate-200 text-slate-700",
  anonymous: "bg-amber-100 text-amber-900",
};

interface Props {
  searchParams: Promise<{
    action?: string;
    actor?: string;
    drm?: string;
    since?: string;
    until?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

const BASE_PATH = "/staff/audit";

// Sortable columns. `parseSort` requires this exact allow-list — the value
// reaches a PostgREST `.order()`, so it is a security boundary, not just a UI
// list. Actor and Resource are the two columns an investigator re-orders by:
// "everything this actor type did" and "all the rows about one resource kind"
// are the questions the log gets asked. IP and Metadata stay plain — an IP
// sorts as text (10.x before 9.x) and metadata is JSONB with no meaningful
// order.
const SORTABLE_COLUMNS = ["created_at", "action", "actor_type", "resource_type"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "created_at", dir: "desc" };

// `resource_type` is null on rows that aren't about one stored object (a
// sign-in, a rate-limit trip) and renders as "—". Sink those to the bottom
// either way, so ordering by Resource doesn't just surface every blank first.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["resource_type"]);

// This page has always shown 50 rows; the picker can change it, but an
// existing bookmark keeps the size it was written with.
const DEFAULT_SIZE = 50;

export default async function AuditLogPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, DEFAULT_SIZE);
  const page = parsePage(params.page);
  const [offset, rangeTo] = rangeFor(page, size);

  // Resolve a DRM-ID to its patient_id once, then filter audit rows by
  // that patient_id. We use the admin client because the staff_profiles
  // RLS policy restricts patient lookups for admins via the same path.
  let patientFilter: { id: string; label: string } | null = null;
  let patientLookupError: string | null = null;
  if (params.drm && params.drm.trim().length > 0) {
    const drm = params.drm.trim().toUpperCase();
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("patients")
      .select("id, drm_id, first_name, last_name")
      .eq("drm_id", drm)
      .maybeSingle();
    if (row) {
      patientFilter = {
        id: row.id,
        label: `${row.last_name}, ${row.first_name} (${row.drm_id})`,
      };
    } else {
      patientLookupError = `No patient with DRM-ID ${drm}.`;
    }
  }

  const supabase = await createClient();
  let query = supabase
    .from("audit_log")
    .select(
      "id, actor_id, actor_type, patient_id, action, resource_type, resource_id, ip_address, created_at, metadata",
      { count: "exact" },
    )
    .order(sort.key, {
      ascending: sort.dir === "asc",
      ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
    })
    // Tie-break on id — without a total order, `.range()` can drop or repeat
    // rows across pages, and every column here ties freely (a burst of rows
    // can share a `created_at`, and thousands share an `actor_type`).
    .order("id", { ascending: true })
    .range(offset, rangeTo);

  if (params.action) {
    query = query.ilike("action", `${params.action}%`);
  }
  if (params.actor) {
    query = query.eq("actor_type", params.actor);
  }
  if (patientFilter) {
    query = query.eq("patient_id", patientFilter.id);
  }
  // since: inclusive lower bound on created_at. Treat the date input as a
  // Manila local date and shift to UTC midnight for the comparison.
  if (params.since) {
    const sinceIso = manilaDateStartUtc(params.since);
    if (sinceIso) query = query.gte("created_at", sinceIso);
  }
  if (params.until) {
    const untilIso = manilaDateEndUtc(params.until);
    if (untilIso) query = query.lte("created_at", untilIso);
  }
  if (patientLookupError) {
    // Force an empty result set so the user sees the error message
    // without rows from a broader query confusing the picture.
    query = query.eq("id", -1);
  }

  const { data: rows, count } = await query;
  const total = count ?? 0;
  const totalPages = pageCount(total, size);

  // Params sitting at their default are left out, so page 1 with the default
  // sort and size stays the bare /staff/audit URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    action: params.action ?? null,
    actor: params.actor ?? null,
    drm: params.drm ?? null,
    since: params.since ?? null,
    until: params.until ?? null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_SIZE ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // A re-sort resets to page 1 — staying on page 7 of a set that just
    // reordered is a screenful of unrelated rows with no explanation.
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  const hasAnyFilter = Boolean(
    params.action || params.actor || params.drm || params.since || params.until,
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Audit Log
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Every patient-data access, every staff action. Read-only — under
          RA 10173, this record cannot be edited.
        </p>
      </header>

      {/* A browser submits only the fields the form carries, so without these
          hidden inputs pressing Filter would silently reset the sort and the
          page size the reader had chosen. */}
      <form className="mb-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === DEFAULT_SIZE ? null : (
          <input type="hidden" name="size" value={String(size)} />
        )}
        <input
          type="search"
          name="action"
          defaultValue={params.action ?? ""}
          placeholder="action prefix · e.g. patient. or result."
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none lg:col-span-2"
        />
        <input
          type="search"
          name="drm"
          defaultValue={params.drm ?? ""}
          placeholder="DRM-ID · e.g. DRM-0042"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <select
          name="actor"
          defaultValue={params.actor ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">Any actor</option>
          <option value="staff">Staff</option>
          <option value="patient">Patient</option>
          <option value="system">System</option>
          <option value="anonymous">Anonymous</option>
        </select>
        <div className="grid grid-cols-2 gap-2 lg:col-span-1">
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
        <div className="flex gap-2 lg:col-span-5">
          <button
            type="submit"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Filter
          </button>
          {hasAnyFilter ? (
            // Clears the FILTERS, not the view: the chosen sort and page size
            // survive, the same way gift codes' "Clear batch" keeps the
            // active search.
            <Link
              href={buildListHref(BASE_PATH, baseParams, {
                action: null,
                actor: null,
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
        </div>
      </form>

      {patientFilter ? (
        <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Filtered to <strong>{patientFilter.label}</strong>.
        </p>
      ) : null}
      {patientLookupError ? (
        <p className="mb-3 text-xs text-amber-700" role="alert">
          {patientLookupError}
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("created_at", "Time")}
              {th("action", "Action")}
              {th("actor_type", "Actor")}
              {th("resource_type", "Resource")}
              <PlainTh label="IP" />
              <PlainTh label="Metadata" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {(rows ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No matching audit entries.
                </td>
              </tr>
            ) : (
              (rows ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-mid)]">
                    {manilaDateTime(r.created_at)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.action}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        ACTOR_TYPE_STYLE[r.actor_type] ?? ""
                      }`}
                    >
                      {r.actor_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                    {r.resource_type ? `${r.resource_type}:${(r.resource_id ?? "").slice(0, 8)}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                    {(r.ip_address as unknown as string) ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {r.metadata ? (
                      <code className="block max-w-[24rem] overflow-x-auto rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-700">
                        {JSON.stringify(r.metadata)}
                      </code>
                    ) : (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))
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
          // Resizing resets to page 1 — same reasoning as a re-sort.
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === DEFAULT_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="entry"
        plural="entries"
      />
    </div>
  );
}

// Manila is UTC+8 with no DST, so the start of a Manila date is
// (date) 00:00 PHT = (date) -08:00 UTC. We accept the date input
// (YYYY-MM-DD) as a Manila local date.
function manilaDateStartUtc(yyyymmdd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd}T00:00:00+08:00`;
}

function manilaDateEndUtc(yyyymmdd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd}T23:59:59.999+08:00`;
}
