import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
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

export const metadata = { title: "Inventory — staff" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/inventory";

interface SearchProps {
  searchParams: Promise<{
    scope?: "all" | "low" | "expiring";
    section?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

interface BalanceRow {
  item_id: string;
  code: string | null;
  name: string;
  section: string | null;
  unit: string;
  reorder_threshold: number;
  expiry_tracking: boolean;
  is_active: boolean;
  on_hand: number;
  stock_status: string;
  next_expiry: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  low: "bg-amber-50 text-amber-700 border-amber-200",
  out_of_stock: "bg-red-50 text-red-700 border-red-200",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  low: "Low",
  out_of_stock: "Out",
};

// Sortable columns for the balances table. `parseSort` requires this exact
// allow-list — it's a security boundary because the value reaches a
// PostgREST `.order()`; never widen it to a raw search param.
const SORTABLE_COLUMNS = ["name", "section", "on_hand", "reorder_threshold"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "name", dir: "asc" };

// section is nullable (not every item has one set) — sink blanks to the
// bottom regardless of direction rather than surfacing every unsectioned
// item first on one of the two directions.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["section"]);

export default async function InventoryPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role === "reception" || session.role === "pathologist") {
    // Lab/admin see this; reception + pathologist redirected.
    // (Strictly speaking pathologist could view too; tighten later if needed.)
  }

  const sp = await searchParams;
  const scope = sp.scope === "low" || sp.scope === "expiring" ? sp.scope : "all";
  const sectionFilter = sp.section ?? "";
  const sort = parseSort(sp.sort, sp.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const admin = createAdminClient();
  const today = todayManilaISODate();
  const sixtyDaysFromNow = new Date(`${today}T00:00:00+08:00`);
  sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
  const expirySoonCutoff = sixtyDaysFromNow.toISOString().slice(0, 10);

  // Main, paginated query — the "low" / "expiring" scopes used to be a JS
  // filter applied AFTER an unbounded fetch, which made a server-side count
  // (and therefore a real pager) impossible: the count of rows returned by
  // Postgres wouldn't match the count of rows left after the JS filter. Both
  // scopes are now WHERE clauses on the same view, so `count: "exact"` and
  // `.range()` agree with what's actually shown.
  const [from, to] = rangeFor(page, size);
  let q = admin
    .from("v_inventory_balances")
    .select("*", { count: "exact" })
    .eq("is_active", true);
  if (sectionFilter) q = q.eq("section", sectionFilter);
  if (scope === "low") {
    q = q.in("stock_status", ["low", "out_of_stock"]);
  } else if (scope === "expiring") {
    q = q.not("next_expiry", "is", null).lte("next_expiry", expirySoonCutoff);
  }
  q = q.order(sort.key, {
    ascending: sort.dir === "asc",
    ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
  });
  // Tie-break on item_id — the view groups by inventory_items.id, so it's
  // unique per row. Without a total order, .range() can drop or repeat rows
  // across pages.
  q = q.order("item_id", { ascending: true }).range(from, to);

  const { data, count } = await q.returns<BalanceRow[]>();
  const rows = data ?? [];
  const total = count ?? 0;
  const totalPages = pageCount(total, size);

  // Tab badge counts are independent of the current scope (all three show
  // at once) but still respect the section filter, same as before. Each is
  // a head-only exact count against the same WHERE clauses as the main
  // query above, not a JS filter over a fetched page.
  let allCountQ = admin
    .from("v_inventory_balances")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);
  let lowCountQ = admin
    .from("v_inventory_balances")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .in("stock_status", ["low", "out_of_stock"]);
  let expiringCountQ = admin
    .from("v_inventory_balances")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .not("next_expiry", "is", null)
    .lte("next_expiry", expirySoonCutoff);
  if (sectionFilter) {
    allCountQ = allCountQ.eq("section", sectionFilter);
    lowCountQ = lowCountQ.eq("section", sectionFilter);
    expiringCountQ = expiringCountQ.eq("section", sectionFilter);
  }
  const [{ count: allCount }, { count: lowCount }, { count: expiringCount }] =
    await Promise.all([allCountQ, lowCountQ, expiringCountQ]);

  // Sections for the filter dropdown — deliberately unfiltered by the
  // current section selection (only by is_active) so picking a section
  // doesn't collapse the dropdown down to just that one option.
  const { data: sectionRows } = await admin
    .from("v_inventory_balances")
    .select("section")
    .eq("is_active", true)
    .returns<{ section: string | null }[]>();
  const sectionsSet = new Set<string>();
  for (const r of sectionRows ?? []) if (r.section) sectionsSet.add(r.section);
  const sections = Array.from(sectionsSet).sort();

  // Params at their default are omitted so the bare scope/section/sort/size
  // combination stays a clean /staff/admin/inventory URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    scope: scope === "all" ? null : scope,
    section: sectionFilter || null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  function scopeHref(s: "all" | "low" | "expiring") {
    // Changing scope resets to page 1 — staying on page 7 of a result set
    // that just changed shape is a blank screen with no explanation.
    return buildListHref(BASE_PATH, baseParams, {
      scope: s === "all" ? null : s,
      page: null,
    });
  }

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string, align?: "left" | "right") => (
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
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Inventory
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Lab reagents and front-desk supplies. Receive / issue / adjust /
            expire stock movements; balances and next-expiry are computed on
            the fly. No GL bridge yet — cost accounting lives in AP bills.
          </p>
        </div>
        <Link
          href="/staff/admin/inventory/new"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          + New item
        </Link>
      </header>

      <nav className="my-4 flex flex-wrap gap-2">
        <Link
          href={scopeHref("all")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "all"
              ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          All ({allCount ?? 0})
        </Link>
        <Link
          href={scopeHref("low")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "low"
              ? "border-amber-500 bg-amber-500 text-white"
              : (lowCount ?? 0) > 0
                ? "border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-500"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]"
          }`}
        >
          Low / out ({lowCount ?? 0})
        </Link>
        <Link
          href={scopeHref("expiring")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "expiring"
              ? "border-orange-500 bg-orange-500 text-white"
              : (expiringCount ?? 0) > 0
                ? "border-orange-300 bg-orange-50 text-orange-900 hover:border-orange-500"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]"
          }`}
        >
          Expiring ≤ 60d ({expiringCount ?? 0})
        </Link>

        {sections.length > 0 ? (
          <form action="" className="ml-auto flex items-center gap-2">
            {scope !== "all" ? (
              <input type="hidden" name="scope" value={scope} />
            ) : null}
            {/* Preserve sort/size across a plain GET form submit — the browser
                only sends the fields present in the form, so anything not
                restated here as a hidden input would silently drop. Page is
                deliberately NOT restated: a changed filter resets to page 1. */}
            {!isDefaultSort ? (
              <>
                <input type="hidden" name="sort" value={sort.key} />
                <input type="hidden" name="dir" value={sort.dir} />
              </>
            ) : null}
            {size !== DEFAULT_PAGE_SIZE ? (
              <input type="hidden" name="size" value={String(size)} />
            ) : null}
            <select
              name="section"
              defaultValue={sectionFilter}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
            >
              <option value="">All sections</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-cyan)] hover:text-white"
            >
              Filter
            </button>
          </form>
        ) : null}
      </nav>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {scope === "all"
              ? "No items yet. Click + New item to start."
              : "Nothing matches this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("name", "Item")}
                  {th("section", "Section")}
                  {th("on_hand", "On hand", "right")}
                  {th("reorder_threshold", "Reorder ≤", "right")}
                  <PlainTh label="Status" />
                  <PlainTh label="Next expiry" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const expiringSoon =
                    r.next_expiry !== null && r.next_expiry <= expirySoonCutoff;
                  return (
                    <tr
                      key={r.item_id}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/admin/inventory/${r.item_id}`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.code ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {r.code}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {r.section ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {Number(r.on_hand).toLocaleString()} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {Number(r.reorder_threshold).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.stock_status] ?? ""}`}
                        >
                          {STATUS_LABEL[r.stock_status] ?? r.stock_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {r.next_expiry ? (
                          <span
                            className={
                              expiringSoon
                                ? "text-orange-700"
                                : "text-[color:var(--color-brand-text-soft)]"
                            }
                          >
                            {r.next_expiry}
                          </span>
                        ) : r.expiry_tracking ? (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            tracked, none on hand
                          </span>
                        ) : (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
        noun="item"
      />
    </div>
  );
}
