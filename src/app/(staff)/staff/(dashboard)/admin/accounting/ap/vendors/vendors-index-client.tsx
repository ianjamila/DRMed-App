"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  type SortDir,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

const BASE_PATH = "/staff/admin/accounting/ap/vendors";

type Vendor = {
  id: string;
  name: string;
  tin: string | null;
  is_active: boolean;
  is_partner_lab: boolean;
  outstanding_php: number;
  ytd_spend_php: number;
  last_bill_date: string | null;
};

// Sortable columns for the vendors list. `parseSort` requires this exact
// allow-list — even though this table sorts a client-held array rather than
// a PostgREST query, an unrecognised `?sort=` must still fall back to the
// default instead of indexing into the row with an arbitrary string.
const SORTABLE_COLUMNS = ["name", "outstanding_php", "ytd_spend_php", "last_bill_date"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "name", dir: "asc" };

function compareString(a: string, b: string, dir: SortDir): number {
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

function compareNumber(a: number, b: number, dir: SortDir): number {
  return dir === "asc" ? a - b : b - a;
}

// A vendor with no bills yet has no last_bill_date — it sinks to the bottom
// regardless of direction, rather than flipping to the top on ASC.
function compareNullableDate(a: string | null, b: string | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compareNumber(Date.parse(a), Date.parse(b), dir);
}

function compareVendors(a: Vendor, b: Vendor, sort: SortSpec<SortColumn>): number {
  let cmp: number;
  switch (sort.key) {
    case "name":
      cmp = compareString(a.name, b.name, sort.dir);
      break;
    case "outstanding_php":
      cmp = compareNumber(a.outstanding_php, b.outstanding_php, sort.dir);
      break;
    case "ytd_spend_php":
      cmp = compareNumber(a.ytd_spend_php, b.ytd_spend_php, sort.dir);
      break;
    case "last_bill_date":
      // last_bill_date is a plain YYYY-MM-DD; Date.parse gives a real
      // numeric value to sort by rather than comparing the ISO strings.
      cmp = compareNullableDate(a.last_bill_date, b.last_bill_date, sort.dir);
      break;
  }
  // Array.prototype.sort is stable, but the rows arrive in whatever order
  // the server query returned them — without an explicit id tie-break, rows
  // that compare equal on the visible column could still swap between
  // renders and shift the page slice.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

export function VendorsIndexClient({ initialVendors }: { initialVendors: Vendor[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // Sort and page live in the URL, per the shared ?sort=&dir=&page=&size=
  // contract the server list pages use — search/showInactive stay local
  // component state exactly as before (they never touched the URL).
  const sort = parseSort(
    searchParams.get("sort") ?? undefined,
    searchParams.get("dir") ?? undefined,
    SORTABLE_COLUMNS,
    DEFAULT_SORT,
  );
  const size = parsePageSize(searchParams.get("size") ?? undefined, DEFAULT_PAGE_SIZE);
  const page = parsePage(searchParams.get("page") ?? undefined);

  const filtered = useMemo(() => {
    return initialVendors.filter((v) => {
      if (!showInactive && !v.is_active) return false;
      if (search && !v.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [initialVendors, search, showInactive]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareVendors(a, b, sort)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort.key/sort.dir are the actual dependency; `sort` is a fresh object every render
    [filtered, sort.key, sort.dir],
  );

  // The pager's total is the length of the FILTERED array, not the raw
  // vendor count, so it agrees with what's on screen.
  const total = sorted.length;
  const totalPages = pageCount(total, size);
  // Clamped defensively: the effect below navigates away from a stale page
  // when a filter shrinks the result set, but this keeps the render in
  // between from showing a blank slice.
  const pageClamped = Math.min(page, totalPages);
  const pageRows = sorted.slice((pageClamped - 1) * size, pageClamped * size);

  // search/showInactive are plain component state, not URL params — so
  // there's no navigation to hang a "reset page" override off of the way
  // the server list pages do. Instead, watch them directly: any change
  // drops ?page= from the URL, the same rule as sort/size, so filtering
  // down to a handful of vendors while on page 3 doesn't show a blank table.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!searchParams.get("page")) return; // already page 1
    const next = new URLSearchParams(searchParams.toString());
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the filters themselves
  }, [search, showInactive]);

  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string, align: "left" | "right" = "left") => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} align={align} />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search vendors"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-[44px] min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4"
          />
          Include inactive
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("name", "Name")}
              <PlainTh label="TIN" />
              {th("outstanding_php", "Outstanding", "right")}
              {th("ytd_spend_php", "YTD spend", "right")}
              {th("last_bill_date", "Last bill")}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pageRows.map((v) => (
              <tr key={v.id} className={v.is_active ? "" : "opacity-60"}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/vendors/${v.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {v.name}
                  </Link>
                  {v.is_partner_lab && (
                    <span className="ml-2 inline-block rounded bg-[color:var(--color-brand-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-brand-navy)]">
                      Partner lab
                    </span>
                  )}
                  {!v.is_active && (
                    <span className="ml-2 text-xs text-gray-500">(inactive)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                  {v.tin ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(v.outstanding_php)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(v.ytd_spend_php)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {v.last_bill_date ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          {initialVendors.length === 0
            ? "No vendors yet. Add the first one above."
            : "No vendors match your filters."}
        </p>
      )}

      <ListPagination
        page={pageClamped}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          pageClamped > 1
            ? buildListHref(BASE_PATH, baseParams, {
                page: pageClamped - 1 > 1 ? String(pageClamped - 1) : null,
              })
            : null
        }
        nextHref={
          pageClamped < totalPages
            ? buildListHref(BASE_PATH, baseParams, { page: String(pageClamped + 1) })
            : null
        }
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === DEFAULT_PAGE_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="vendor"
      />
    </div>
  );
}
