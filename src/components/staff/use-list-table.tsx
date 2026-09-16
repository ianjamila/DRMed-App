"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { compareListRows, type SortAccessors } from "@/lib/ui/compare-list-rows";
import {
  ariaSortFor, buildListHref, DEFAULT_PAGE_SIZE, nextSort, pageCount,
  parsePage, parsePageSize, parseSort, rangeFor, type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh } from "./sortable-th";
import { ListPagination, PAGE_SIZES } from "./list-pagination";

/** Native history updates useSearchParams without rerunning the dynamic loader.
 * Real hrefs still support reload, copy-link and modified-click navigation.
 */
function navigateTable(href: string) {
  window.history.pushState(null, "", href);
}

/** The report-page URL contract for editable client tables. The caller supplies
 * the COMPLETE filtered set; totals and actions continue to use that full set.
 * Prefixes give sibling tables independent state while preserving each other.
 * Optional secondary keys keep their own directions before the final id tie-break.
 */
export function useListTable<T extends { id: string }, K extends string>(
  rows: readonly T[],
  columns: SortAccessors<T, K>,
  fallback: SortSpec<NoInfer<K>>,
  prefix = "",
  secondary: readonly SortSpec<NoInfer<K>>[] = [],
) {
  const params = useSearchParams();
  const path = usePathname();
  const param = (key: string) => `${prefix}${key}`;
  const sort = parseSort(params.get(param("sort")) ?? undefined,
    params.get(param("dir")) ?? undefined, Object.keys(columns) as K[], fallback);
  const size = parsePageSize(params.get(param("size")) ?? undefined);
  const total = rows.length;
  const totalPages = pageCount(total, size);
  const page = Math.min(parsePage(params.get(param("page")) ?? undefined), totalPages);
  const isDefaultSort = sort.key === fallback.key && sort.dir === fallback.dir;
  const baseParams = {
    // Match params.get(): the first occurrence wins, including sibling state.
    ...Object.fromEntries(Array.from(params.keys(), (key) => [key, params.get(key)])),
    [param("sort")]: isDefaultSort ? null : sort.key,
    [param("dir")]: isDefaultSort ? null : sort.dir,
    [param("size")]: size === DEFAULT_PAGE_SIZE ? null : String(size),
    [param("page")]: null,
  };
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(path, baseParams, overrides);
  const th = (key: K, label: string, align: "left" | "right" = "left") => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === fallback.key && next.dir === fallback.dir;
    return <SortableTh navigate={navigateTable} key={key} label={label} align={align} state={ariaSortFor(sort, key)}
      href={href({ [param("sort")]: nextIsDefault ? null : next.key,
        [param("dir")]: nextIsDefault ? null : next.dir })} />;
  };
  const [from, to] = rangeFor(page, size);
  return {
    rows: [...rows].sort((a, b) => compareListRows(a, b, sort, columns, secondary)).slice(from, to + 1),
    th,
    href,
    pagination: <ListPagination navigate={navigateTable} page={page} pageCount={totalPages} total={total} size={size}
      pageSizeLabelId={`${prefix}page-size-label`}
      prevHref={page > 1 ? href({ [param("page")]: page > 2 ? String(page - 1) : null }) : null}
      nextHref={page < totalPages ? href({ [param("page")]: String(page + 1) }) : null}
      sizeOptions={PAGE_SIZES.map((s) => ({ size: s,
        href: href({ [param("size")]: s === DEFAULT_PAGE_SIZE ? null : String(s) }) }))} />,
  };
}
