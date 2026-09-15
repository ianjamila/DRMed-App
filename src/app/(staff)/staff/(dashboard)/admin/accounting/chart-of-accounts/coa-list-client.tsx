"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toggleAccountActiveAction } from "./actions";
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
  type SortDir,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

interface CoaRow {
  id: string;
  code: string;
  name: string;
  type: string;
  typeLabel: string;
  typeOrder: number;
  parent_id: string | null;
  normal_balance: string;
  is_active: boolean;
  description: string | null;
}

type Filter = "all" | "active" | "inactive";

const BASE_PATH = "/staff/admin/accounting/chart-of-accounts";

// Sortable columns *within* an account-type group. `type` itself isn't
// here: the grouping order (assets, then liabilities, equity, …) mirrors
// the financial-statement structure the whole page is organised around,
// and is deliberately not something a column click re-orders — see the
// grouping note on `sorted` below. Even though this sorts a client-held
// array rather than a PostgREST query, `parseSort` still requires this
// exact allow-list so an unrecognised `?sort=` falls back instead of
// indexing into the row with an arbitrary string.
const SORTABLE_COLUMNS = ["code", "name", "normal_balance", "is_active"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "code", dir: "asc" };

function valueFor(row: CoaRow, key: SortColumn): string | boolean {
  switch (key) {
    case "code":
      return row.code;
    case "name":
      return row.name;
    case "normal_balance":
      return row.normal_balance;
    case "is_active":
      return row.is_active;
  }
}

// None of these columns are nullable (code/name/normal_balance are
// required, is_active is a plain boolean) — so unlike the other list
// pages there's no "blanks sink to the bottom" case to handle here.
function compareValues(a: string | boolean, b: string | boolean, dir: SortDir): number {
  if (typeof a === "boolean" && typeof b === "boolean") {
    const cmp = Number(a) - Number(b);
    return dir === "asc" ? cmp : -cmp;
  }
  const cmp = String(a).localeCompare(String(b), "en", { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

export function CoaListClient({ rows }: { rows: CoaRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Sort and page live in the URL, per the shared ?sort=&dir=&page=&size=
  // contract the server list pages use — filter/query stay local component
  // state exactly as before (they never touched the URL).
  const sort = parseSort(
    searchParams.get("sort") ?? undefined,
    searchParams.get("dir") ?? undefined,
    SORTABLE_COLUMNS,
    DEFAULT_SORT,
  );
  const size = parsePageSize(searchParams.get("size") ?? undefined, DEFAULT_PAGE_SIZE);
  const page = parsePage(searchParams.get("page") ?? undefined);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && !r.is_active) return false;
      if (filter === "inactive" && r.is_active) return false;
      if (q && !r.code.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, filter, query]);

  // Sort within each type group: `typeOrder` is always primary and fixed,
  // so changing the sort column only reorders accounts inside their
  // existing section, never across sections. `id` is the final tie-break —
  // without it, two accounts equal on the sort column could swap sides of
  // a page boundary between renders.
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (a.typeOrder !== b.typeOrder) return a.typeOrder - b.typeOrder;
      const cmp = compareValues(valueFor(a, sort.key), valueFor(b, sort.key), sort.dir);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });
  }, [filtered, sort.key, sort.dir]);

  // The pager's total is the length of the FILTERED array, not the raw
  // account count, so it agrees with what's on screen.
  const total = sorted.length;
  const totalPages = pageCount(total, size);
  // Clamped defensively: the effect below navigates away from a stale page
  // when a filter shrinks the result set, but this keeps the render in
  // between from showing a blank slice.
  const pageClamped = Math.min(page, totalPages);
  const pageRows = sorted.slice((pageClamped - 1) * size, pageClamped * size);

  // filter/query are plain component state, not URL params — so there's no
  // navigation to hang a "reset page" override off of the way sort/size
  // links do. Instead, watch them directly: any change drops ?page= from
  // the URL, the same rule as sort/size, so filtering down to a handful of
  // accounts while on page 3 doesn't show a blank table.
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
  }, [filter, query]);

  // Section counts reflect the whole filtered set, not just what made it
  // onto this page — otherwise "Assets (12)" would understate how many
  // asset accounts actually match once a page boundary splits the group.
  const groupTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of filtered) totals.set(r.type, (totals.get(r.type) ?? 0) + 1);
    return totals;
  }, [filtered]);

  // Re-group just the visible page slice. Because `sorted` already puts
  // same-type rows together, a page that lands mid-group simply renders a
  // partial section — the same section reappears (continued) on the next
  // page, which is normal for a paginated, grouped table.
  const grouped = useMemo(() => {
    const buckets = new Map<string, { type: string; typeOrder: number; label: string; rows: CoaRow[] }>();
    for (const r of pageRows) {
      if (!buckets.has(r.type)) {
        buckets.set(r.type, { type: r.type, typeOrder: r.typeOrder, label: r.typeLabel, rows: [] });
      }
      buckets.get(r.type)!.rows.push(r);
    }
    return Array.from(buckets.values()).sort((a, b) => a.typeOrder - b.typeOrder);
  }, [pageRows]);

  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // Any change to sort resets to page 1 — staying on a page that just
    // reordered underneath you is how you get a confusing, maybe-empty view.
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
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["all", "active", "inactive"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`min-h-[44px] rounded-full px-3 text-xs font-bold uppercase tracking-wider ${
                filter === f
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search code or name…"
          className="min-h-[44px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-sm"
        />
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-12 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No accounts match.
        </p>
      ) : (
        grouped.map((group) => (
          <section key={group.label} className="mb-6">
            <h2 className="mb-2 font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              {group.label} ({groupTotals.get(group.type) ?? group.rows.length})
            </h2>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    {th("code", "Code")}
                    {th("name", "Name")}
                    {th("normal_balance", "Normal")}
                    {th("is_active", "Status")}
                    <PlainTh label="" />
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r) => (
                    <Row key={r.id} row={r} />
                  ))}
                </tbody>
              </table>
            </Panel>
          </section>
        ))
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
          // Changing the page size resets to page 1 — same reasoning as sort.
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === DEFAULT_PAGE_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="account"
      />
    </>
  );
}

function Row({ row }: { row: CoaRow }) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onToggle() {
    startTransition(async () => {
      setErr(null);
      const result = await toggleAccountActiveAction(row.id);
      if (!result.ok) setErr(result.error);
    });
  }

  return (
    <tr className={`border-t border-[color:var(--color-brand-bg-mid)] ${!row.is_active ? "opacity-60" : ""}`}>
      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
      <td className="px-3 py-2">
        <div className="font-medium text-[color:var(--color-brand-navy)]">{row.name}</div>
        {row.description ? (
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">{row.description}</div>
        ) : null}
        {err ? <div className="mt-1 text-xs text-red-600">{err}</div> : null}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${
            row.normal_balance === "debit" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {row.normal_balance}
        </span>
      </td>
      <td className="px-3 py-2 text-xs">
        {row.is_active ? "Active" : "Inactive"}
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/staff/admin/accounting/chart-of-accounts/${row.id}/edit`}
          className="mr-2 inline-flex min-h-[44px] items-center rounded px-2 text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center rounded px-2 text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline disabled:opacity-50"
        >
          {pending ? "…" : row.is_active ? "Deactivate" : "Activate"}
        </button>
      </td>
    </tr>
  );
}
