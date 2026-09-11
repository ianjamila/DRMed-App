import Link from "next/link";

/**
 * A sortable column header for the staff list tables.
 *
 * Server component by design: the whole sort state lives in the URL, so the
 * header is a plain link and the page needs no client JS to sort. `state`
 * drives `aria-sort`, which is what a screen-reader user relies on to know
 * which column is ordering the table.
 *
 * Props are serialisable data only — the caller builds the href (see
 * `buildListHref` / `nextSort` in `@/lib/ui/table-params`).
 */
export function SortableTh({
  label,
  href,
  state,
  align = "left",
}: {
  label: string;
  href: string;
  state: "ascending" | "descending" | "none";
  align?: "left" | "right";
}) {
  const active = state !== "none";
  return (
    <th
      scope="col"
      aria-sort={state}
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <Link
        href={href}
        className={`group inline-flex items-center gap-1 hover:text-[color:var(--color-brand-navy)] ${
          active ? "text-[color:var(--color-brand-navy)]" : ""
        }`}
      >
        {label}
        {/* The caret is decorative — `aria-sort` on the th already carries the
            state, so announcing it again would just be noise. */}
        <span aria-hidden="true" className={active ? "" : "opacity-0 group-hover:opacity-40"}>
          {state === "ascending" ? "▲" : "▼"}
        </span>
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
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {label}
    </th>
  );
}
