"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/lib/ui/status-badge";
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

const BASE_PATH = "/staff/admin/accounting/ap/payments";

type Vendor = { id: string; name: string };

type Payment = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  payment_number: string;
  payment_date: string;
  method: string;
  amount_php: number;
  cash_account_id: string;
  reference: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
};

type Filter = {
  vendor_id: string;
  method: string;
  q: string;
};

const METHODS = ["cash", "bank_transfer", "gcash", "cheque"] as const;

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  cheque: "Cheque",
};
const methodLabel = (m: string) => METHOD_LABEL[m] ?? m;

// Sortable columns for the payments list. `parseSort` requires this exact
// allow-list — even though this table sorts a client-held array rather than
// a PostgREST query, an unrecognised `?sort=` must still fall back to the
// default instead of indexing into the row with an arbitrary string.
const SORTABLE_COLUMNS = ["payment_date", "vendor_name", "method", "amount_php"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "payment_date", dir: "desc" };

function compareString(a: string, b: string, dir: SortDir): number {
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

function compareNumber(a: number, b: number, dir: SortDir): number {
  return dir === "asc" ? a - b : b - a;
}

// A payment whose vendor join failed to resolve a name sinks to the bottom
// regardless of direction, rather than flipping to the top on ASC.
function compareNullableString(a: string | null, b: string | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compareString(a, b, dir);
}

function comparePayments(a: Payment, b: Payment, sort: SortSpec<SortColumn>): number {
  let cmp: number;
  switch (sort.key) {
    case "payment_date":
      // payment_date is a plain YYYY-MM-DD; Date.parse gives a real numeric
      // value to sort by rather than comparing the ISO strings.
      cmp = compareNumber(Date.parse(a.payment_date), Date.parse(b.payment_date), sort.dir);
      break;
    case "vendor_name":
      cmp = compareNullableString(a.vendor_name, b.vendor_name, sort.dir);
      break;
    case "method":
      cmp = compareString(methodLabel(a.method), methodLabel(b.method), sort.dir);
      break;
    case "amount_php":
      cmp = compareNumber(a.amount_php, b.amount_php, sort.dir);
      break;
  }
  // Array.prototype.sort is stable, but the rows arrive in whatever order
  // the server query returned them — without an explicit id tie-break, rows
  // that compare equal on the visible column could still swap between
  // renders and shift the page slice.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

export function PaymentsIndexClient({
  initialPayments,
  vendors,
  initialFilter,
}: {
  initialPayments: Payment[];
  vendors: Vendor[];
  initialFilter: Filter;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>(initialFilter);

  // Filtering already happened server-side (the Apply button below navigates
  // with vendor_id/method/q, which the page re-fetches by). Sort and page
  // are purely client-side on top of whatever rows came back, per the shared
  // ?sort=&dir=&page=&size= contract the server list pages use.
  const sort = parseSort(
    searchParams.get("sort") ?? undefined,
    searchParams.get("dir") ?? undefined,
    SORTABLE_COLUMNS,
    DEFAULT_SORT,
  );
  const size = parsePageSize(searchParams.get("size") ?? undefined, DEFAULT_PAGE_SIZE);
  const page = parsePage(searchParams.get("page") ?? undefined);

  const sorted = useMemo(
    () => [...initialPayments].sort((a, b) => comparePayments(a, b, sort)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort.key/sort.dir are the actual dependency; `sort` is a fresh object every render
    [initialPayments, sort.key, sort.dir],
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
    if (filter.method) next.set("method", filter.method);
    else next.delete("method");
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
    setFilter({ vendor_id: "", method: "", q: "" });
    const next = new URLSearchParams(searchParams.toString());
    next.delete("vendor_id");
    next.delete("method");
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
  // `initialPayments` actually is — the applied filter, not whatever is
  // sitting unsaved in the form.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    vendor_id: searchParams.get("vendor_id"),
    method: searchParams.get("method"),
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
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
          value={filter.method}
          onChange={(e) => setFilter((f) => ({ ...f, method: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All methods</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {methodLabel(m)}
            </option>
          ))}
        </select>

        <input
          type="search"
          placeholder="Payment # / reference / cheque #"
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
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <PlainTh label="Payment #" />
              {th("vendor_name", "Vendor")}
              {th("payment_date", "Date")}
              {th("method", "Method")}
              <PlainTh label="Reference" />
              {th("amount_php", "Amount", "right")}
              <PlainTh label="Status" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pageRows.map((p) => (
              <tr key={p.id} className={p.voided_at ? "opacity-60" : ""}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/payments/${p.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {p.payment_number}
                  </Link>
                </td>
                <td className="px-3 py-2">{p.vendor_name ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{manilaDate(p.payment_date)}</td>
                <td className="px-3 py-2 text-xs">{methodLabel(p.method)}</td>
                <td className="px-3 py-2 text-xs">
                  {p.cheque_number ?? p.reference ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(p.amount_php)}
                </td>
                <td className="px-3 py-2">
                  {p.voided_at ? <StatusBadge status="voided" /> : <span className="text-xs text-[color:var(--color-brand-text-soft)]">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No payments match your filters.
        </p>
      )}

      {/* The fetch IS the universe this pager describes, so on the day the
          clinic has more than AP_INDEX_MAX_ROWS matching payments the pager would
          quietly describe a truncated set. Say so instead. */}
      {total >= AP_INDEX_MAX_ROWS && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {AP_INDEX_MAX_ROWS.toLocaleString("en-PH")} payments that match — narrow the
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
        noun="payment"
      />
    </div>
  );
}
