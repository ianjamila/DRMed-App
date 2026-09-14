import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
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
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = {
  title: "Services — staff",
};

interface SearchProps {
  searchParams: Promise<{
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

const BASE_PATH = "/staff/services";

// Sortable columns for the catalog. `parseSort` requires this exact
// allow-list — it's a security boundary because the value reaches a
// PostgREST `.order()`; never widen it to a raw search param. `section` is
// fetched below but isn't a column this table shows, so it's left off this
// list — only what's visibly a column is sortable.
const SORTABLE_COLUMNS = [
  "code",
  "name",
  "price_php",
  "turnaround_hours",
  "is_active",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "name", dir: "asc" };

// turnaround_hours is nullable (not every service has a fixed TAT) and
// renders as "—" — sink blanks to the bottom regardless of direction so a
// sort doesn't just surface every untimed service first.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["turnaround_hours"]);

interface ServiceRow {
  id: string;
  code: string;
  name: string;
  price_php: number;
  hmo_price_php: number | null;
  turnaround_hours: number | null;
  is_active: boolean;
  requires_signoff: boolean;
  is_send_out: boolean;
  section: string | null;
}

async function search(sort: SortSpec<SortColumn>, page: number, size: number) {
  const supabase = await createClient();
  const [from, to] = rangeFor(page, size);

  let q = supabase
    .from("services")
    .select(
      "id, code, name, price_php, hmo_price_php, turnaround_hours, is_active, requires_signoff, is_send_out, section",
      { count: "exact" },
    );

  q = q.order(sort.key, {
    ascending: sort.dir === "asc",
    ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
  });
  // Tie-break on id — without a total order, .range() can drop or repeat
  // rows across pages.
  q = q.order("id", { ascending: true }).range(from, to);

  const { data, error, count } = await q.returns<ServiceRow[]>();
  if (error) {
    console.error("services list failed", error);
    return { rows: [], total: 0 };
  }
  return { rows: data ?? [], total: count ?? 0 };
}

export default async function ServicesAdminPage({ searchParams }: SearchProps) {
  await requireAdminStaff();

  const params = await searchParams;
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);
  const { rows: services, total } = await search(sort, page, size);
  const totalPages = pageCount(total, size);

  // Params at their default are omitted so page 1 with the default sort and
  // size stays the bare /staff/services URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
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
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Services
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Catalog of tests and clinical services. Inactive entries are
            hidden from the marketing site but still usable on existing
            visits.
          </p>
        </div>
        <Link
          href="/staff/services/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New service
        </Link>
      </header>

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("code", "Code")}
              {th("name", "Name")}
              {th("price_php", "Price")}
              {th("turnaround_hours", "Turnaround")}
              {th("is_active", "Status")}
              <PlainTh label="Action" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {services.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No services match.
                </td>
              </tr>
            ) : (
              services.map((s) => (
                <tr
                  key={s.id}
                  className="hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-mono text-[color:var(--color-brand-text-mid)]">
                    {s.code}
                  </td>
                  <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                    {s.name}
                    {s.requires_signoff ? (
                      <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                        Signoff
                      </span>
                    ) : null}
                    {s.hmo_price_php != null ? (
                      <span className="ml-2 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
                        HMO
                      </span>
                    ) : null}
                    {s.is_send_out ? (
                      <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                        Send-out
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">
                      {formatPhp(s.price_php)}
                    </div>
                    {s.hmo_price_php != null ? (
                      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                        HMO {formatPhp(s.hmo_price_php)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {s.turnaround_hours ? `${s.turnaround_hours}h` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {s.is_active ? (
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/services/${s.id}/edit`}
                      className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Edit →
                    </Link>
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
          // Changing the page size resets to page 1 — same reasoning as sort.
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === DEFAULT_PAGE_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="service"
      />
    </div>
  );
}
