import Link from "next/link";

/** Header-cell chrome, shared by the link and button variants. */
export function thClass(align: "left" | "right"): string {
  return `px-4 py-3 text-xs font-semibold uppercase tracking-wider ${
    align === "right" ? "text-right" : "text-left"
  }`;
}

/** The clickable label inside a sortable header. */
export function sortTriggerClass(active: boolean): string {
  return `group inline-flex items-center gap-1 hover:text-[color:var(--color-brand-navy)] ${
    active ? "text-[color:var(--color-brand-navy)]" : ""
  }`;
}

/**
 * The direction caret. Decorative — `aria-sort` on the `th` already carries
 * the state, so announcing it again would just be noise.
 */
export function SortCaret({ state }: { state: SortState }) {
  return (
    <span
      aria-hidden="true"
      className={state !== "none" ? "" : "opacity-0 group-hover:opacity-40"}
    >
      {state === "ascending" ? "▲" : "▼"}
    </span>
  );
}

export type SortState = "ascending" | "descending" | "none";

/**
 * A sortable column header for the staff list tables.
 *
 * Server component by design: the whole sort state lives in the URL, so the
 * header is a plain link and the page needs no client JS to sort. `state`
 * drives `aria-sort`, which is what a screen-reader user relies on to know
 * which column is ordering the table.
 *
 * Props are serialisable data only — the caller builds the href (see
 * `buildListHref` / `nextSort` in `@/lib/ui/table-params`). A table whose
 * rows live in client state instead of the URL uses `ClientSortableTh` from
 * `./client-table-controls`, which renders the same chrome as a button.
 */
export function SortableTh({
  label,
  href,
  state,
  align = "left",
}: {
  label: string;
  href: string;
  state: SortState;
  align?: "left" | "right";
}) {
  return (
    <th scope="col" aria-sort={state} className={thClass(align)}>
      <Link href={href} className={sortTriggerClass(state !== "none")}>
        {label}
        <SortCaret state={state} />
      </Link>
    </th>
  );
}

/** A plain, non-sortable header cell — so a table's `<th>`s stay visually uniform. */
export function PlainTh({
  label,
  align = "left",
}: {
  label: string;
  align?: "left" | "right";
}) {
  return (
    <th scope="col" className={thClass(align)}>
      {label}
    </th>
  );
}
