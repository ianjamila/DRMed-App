"use client";

/**
 * Sorting and paging chrome for a table whose page lives in React state
 * rather than in the URL.
 *
 * Nearly every staff list page keeps `?sort=&dir=&page=&size=` in the URL, so
 * a sorted list can be bookmarked or pasted to a colleague, and the header is
 * a plain `<Link>` with no hydration cost — that is `SortableTh` /
 * `ListPagination`, and it is the default.
 *
 * HMO claims cannot: its rows are already in the browser (the server walks up
 * to 20,000 view rows to make the provider totals exact), and the table
 * carries a checkbox selection that drives bulk actions. Routing a page click
 * through the URL would re-run that 20,000-row walk and discard the
 * selection, so paging there stays local — and these components render
 * exactly the same chrome as the URL-driven pair, from the same class
 * helpers, so the two look and behave alike.
 *
 * The decision logic is shared too: `nextSort`, `ariaSortFor`, `pageCount`
 * and `PAGE_SIZES` all come from `@/lib/ui/table-params`, so "first click
 * sorts descending" means the same thing on both.
 */

import {
  PaginationRangeLabel,
  pageSizeButtonClass,
  pagerControlClass,
} from "./list-pagination";
import { SortCaret, sortTriggerClass, thClass, type SortState } from "./sortable-th";
import { PAGE_SIZES } from "@/lib/ui/table-params";

/** `SortableTh`'s twin: same chrome, but it calls back instead of navigating. */
export function ClientSortableTh({
  label,
  onSort,
  state,
  align = "left",
}: {
  label: string;
  onSort: () => void;
  state: SortState;
  align?: "left" | "right";
}) {
  return (
    <th scope="col" aria-sort={state} className={thClass(align)}>
      <button type="button" onClick={onSort} className={sortTriggerClass(state !== "none")}>
        {label}
        <SortCaret state={state} />
      </button>
    </th>
  );
}

/**
 * `ListPagination`'s twin.
 *
 * `page` is 1-based here, as it is everywhere else in the list contract, even
 * though a client caller is likely holding a 0-based index — convert at the
 * boundary rather than letting two conventions live side by side.
 */
export function ClientListPagination({
  page,
  pageCount,
  total,
  size,
  onPage,
  onSize,
  noun = "row",
  plural,
}: {
  page: number;
  pageCount: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  noun?: string;
  plural?: string;
}) {
  return (
    <nav
      aria-label="Pagination"
      className="mt-6 flex flex-wrap items-center justify-between gap-3"
    >
      <PaginationRangeLabel
        page={page}
        size={size}
        total={total}
        noun={noun}
        plural={plural}
      />

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span
            id="client-page-size-label"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Rows
          </span>
          <span
            className="flex gap-1"
            role="group"
            aria-labelledby="client-page-size-label"
          >
            {PAGE_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSize(s)}
                aria-current={s === size ? "true" : undefined}
                className={pageSizeButtonClass(s === size)}
              >
                {s}
              </button>
            ))}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-[color:var(--color-brand-text-soft)]">
            Page {page} of {pageCount}
          </span>
          <PagerButton
            label="← Previous"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          />
          <PagerButton
            label="Next →"
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
          />
        </div>
      </div>
    </nav>
  );
}

/**
 * A disabled edge is a real `disabled` button rather than inert text — unlike
 * the link variant, this one is focusable chrome, so it has to tell assistive
 * tech it can't be pressed instead of just looking faded.
 */
function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${pagerControlClass} ${
        disabled
          ? "text-[color:var(--color-brand-text-soft)] opacity-50"
          : "transition-colors hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      {label}
    </button>
  );
}
