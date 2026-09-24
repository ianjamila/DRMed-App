"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TriangleAlert } from "lucide-react";
import { StatusBadge } from "@/lib/ui/status-badge";
import { BILL_STATUSES, billStatusLabel } from "@/lib/accounting/ap-labels";
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
import { AP_INDEX_MAX_ROWS } from "@/lib/ui/table-params";
import { manilaDate } from "@/lib/dates/manila";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

const BASE_PATH = "/staff/admin/accounting/ap/bills";

type Vendor = { id: string; name: string };

type Bill = {
  id: string;
  bill_number: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  status: string;
  gross_amount: number;
  wt_amount: number;
  net_payable: number;
  paid_amount: number;
  outstanding_amount: number;
  description: string | null;
  created_at: string;
};

type Filter = {
  vendor_id: string;
  status: string;
  has_wt: boolean;
  q: string;
};

const NOW_MS = Date.now();

// Sortable columns for the bills list. `parseSort` requires this exact
// allow-list — even though this table sorts a client-held array rather than
// a PostgREST query, an unrecognised `?sort=` must still fall back to the
// default instead of indexing into the row with an arbitrary string.
const SORTABLE_COLUMNS = ["bill_date", "vendor_name", "status", "outstanding_amount"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "bill_date", dir: "desc" };

function compareString(a: string, b: string, dir: SortDir): number {
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

function compareNumber(a: number, b: number, dir: SortDir): number {
  return dir === "asc" ? a - b : b - a;
}

// A bill whose vendor join failed to resolve a name sinks to the bottom
// regardless of direction, rather than flipping to the top on ASC.
function compareNullableString(a: string | null, b: string | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compareString(a, b, dir);
}

function compareBills(a: Bill, b: Bill, sort: SortSpec<SortColumn>): number {
  let cmp: number;
  switch (sort.key) {
    case "bill_date":
      // Both bill_date and due_date are plain YYYY-MM-DD; Date.parse gives a
      // real numeric value to sort by rather than comparing the ISO strings.
      cmp = compareNumber(Date.parse(a.bill_date), Date.parse(b.bill_date), sort.dir);
      break;
    case "vendor_name":
      cmp = compareNullableString(a.vendor_name, b.vendor_name, sort.dir);
      break;
    case "status":
      cmp = compareString(a.status, b.status, sort.dir);
      break;
    case "outstanding_amount":
      cmp = compareNumber(a.outstanding_amount, b.outstanding_amount, sort.dir);
      break;
  }
  // Array.prototype.sort is stable, but the rows arrive in whatever order
  // the server query returned them — without an explicit id tie-break, rows
  // that compare equal on the visible column could still swap between
  // renders and shift the page slice.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

export function BillsIndexClient({
  initialBills,
  vendors,
  initialFilter,
}: {
  initialBills: Bill[];
  vendors: Vendor[];
  initialFilter: Filter;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>(initialFilter);

  // Filtering already happened server-side (the Apply button below navigates
  // with vendor_id/status/has_wt/q, which the page re-fetches by). Sort and
  // page are purely client-side on top of whatever rows came back, per the
  // shared ?sort=&dir=&page=&size= contract the server list pages use.
  const sort = parseSort(
    searchParams.get("sort") ?? undefined,
    searchParams.get("dir") ?? undefined,
    SORTABLE_COLUMNS,
    DEFAULT_SORT,
  );
  const size = parsePageSize(searchParams.get("size") ?? undefined, DEFAULT_PAGE_SIZE);
  const page = parsePage(searchParams.get("page") ?? undefined);

  const sorted = useMemo(
    () => [...initialBills].sort((a, b) => compareBills(a, b, sort)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort.key/sort.dir are the actual dependency; `sort` is a fresh object every render
    [initialBills, sort.key, sort.dir],
  );

  // The pager's total is the length of the (already-filtered) array actually
  // on screen, not some raw unfiltered count.
  const total = sorted.length;
  const totalPages = pageCount(total, size);
  // Clamped defensively: a filter Apply that shrinks the result set navigates
  // away from a stale page (see applyFilters/clearFilters below), but this
  // keeps the render in between from showing a blank slice.
  const pageClamped = Math.min(page, totalPages);
  const pageRows = sorted.slice((pageClamped - 1) * size, pageClamped * size);

  function applyFilters() {
    // Clone the full current query string (not just the filter fields) so a
    // sort/size the user already picked survives applying a new filter.
    const next = new URLSearchParams(searchParams.toString());
    if (filter.vendor_id) next.set("vendor_id", filter.vendor_id);
    else next.delete("vendor_id");
    if (filter.status) next.set("status", filter.status);
    else next.delete("status");
    if (filter.has_wt) next.set("has_wt", "1");
    else next.delete("has_wt");
    if (filter.q) next.set("q", filter.q);
    else next.delete("q");
    // Any filter change invalidates the current page slice — always land on
    // page 1 rather than showing an empty table on whatever page the user
    // happened to be on.
    next.delete("page");
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${BASE_PATH}?${qs}` : BASE_PATH);
    });
  }

  function clearFilters() {
    setFilter({ vendor_id: "", status: "", has_wt: false, q: "" });
    const next = new URLSearchParams(searchParams.toString());
    next.delete("vendor_id");
    next.delete("status");
    next.delete("has_wt");
    next.delete("q");
    next.delete("page");
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${BASE_PATH}?${qs}` : BASE_PATH);
    });
  }

  // Params at their default are omitted so page 1 with the default sort and
  // size stays a clean URL. Filter values are read straight from the URL
  // (not the in-progress `filter` state) since they describe what
  // `initialBills` actually is — the applied filter, not whatever is
  // sitting unsaved in the form.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    vendor_id: searchParams.get("vendor_id"),
    status: searchParams.get("status"),
    has_wt: searchParams.get("has_wt"),
    q: searchParams.get("q"),
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

  const oldDrafts = initialBills.filter(
    (b) =>
      b.status === "draft" &&
      (NOW_MS - Date.parse(b.bill_date)) / 86400000 > 7
  ).length;

  return (
    <div className="space-y-4">
      {oldDrafts > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {oldDrafts} draft{oldDrafts !== 1 ? "s" : ""} older than 7 days — review and
            post or delete.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
        <select
          value={filter.vendor_id}
          onChange={(e) => setFilter((f) => ({ ...f, vendor_id: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>

        <select
          value={filter.status}
          onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All statuses</option>
          {BILL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {billStatusLabel(s)}
            </option>
          ))}
        </select>

        <label className="flex min-h-[44px] items-center gap-2 px-3 text-sm text-[color:var(--color-brand-text-soft)]">
          <input
            type="checkbox"
            checked={filter.has_wt}
            onChange={(e) => setFilter((f) => ({ ...f, has_wt: e.target.checked }))}
            className="h-4 w-4"
          />
          Has WT
        </label>

        <input
          type="search"
          placeholder="Bill # / invoice # / desc"
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyFilters();
          }}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />

        <div className="flex gap-2">
          <Button
            type="button"
            variant="brand"
            size="default"
            onClick={applyFilters}
            className="flex-1"
          >
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={clearFilters}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <PlainTh label="Bill #" />
              {th("vendor_name", "Vendor")}
              <PlainTh label="Invoice #" />
              {th("bill_date", "Bill date")}
              <PlainTh label="Due" />
              <PlainTh label="Gross" align="right" />
              <PlainTh label="WT" align="right" />
              {th("outstanding_amount", "Outstanding", "right")}
              {th("status", "Status")}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pageRows.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/bills/${b.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {b.bill_number}
                  </Link>
                </td>
                <td className="px-3 py-2">{b.vendor_name ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{b.vendor_invoice_number ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{manilaDate(b.bill_date)}</td>
                <td className="px-3 py-2 text-xs">{manilaDate(b.due_date)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(b.gross_amount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.wt_amount > 0 ? PHP.format(b.wt_amount) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(b.outstanding_amount)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={b.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No bills match your filters.
        </p>
      )}

      {/* The fetch IS the universe this pager describes, so on the day the
          clinic has more than AP_INDEX_MAX_ROWS matching bills the pager would
          quietly describe a truncated set. Say so instead. */}
      {total >= AP_INDEX_MAX_ROWS && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {AP_INDEX_MAX_ROWS.toLocaleString("en-PH")} bills that match — narrow the
          filters above to see the rest.
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
        noun="bill"
      />
    </div>
  );
}
