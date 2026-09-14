import Link from "next/link";
import { PAGE_SIZES } from "@/lib/ui/table-params";

export interface SizeOption {
  size: number;
  href: string;
}

/**
 * The shared pager for staff list pages: row range, page controls, and a
 * page-size picker.
 *
 * The size picker is a row of LINKS rather than a `<select>` so the whole
 * component stays a server component — it matches the filter-chip pattern used
 * across the staff portal, costs no hydration, and keeps working without JS.
 *
 * `total` is the row count the query reported. When it is an ESTIMATE rather
 * than an exact count, pass `approximate` so the label says "about N" instead
 * of asserting a precision the number doesn't have.
 *
 * `noun` is pluralised by appending "s", which is wrong for an irregular
 * noun like "inquiry" — pass `plural` explicitly ("inquiries") when that's
 * the case.
 */
export function ListPagination({
  page,
  pageCount,
  total,
  size,
  prevHref,
  nextHref,
  sizeOptions,
  approximate = false,
  noun = "row",
  plural,
}: {
  page: number;
  pageCount: number;
  total: number;
  size: number;
  prevHref: string | null;
  nextHref: string | null;
  sizeOptions: SizeOption[];
  approximate?: boolean;
  noun?: string;
  plural?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  return (
    <nav
      aria-label="Pagination"
      className="mt-6 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-[color:var(--color-brand-text-soft)]">
        {total === 0 ? (
          <>No {plural ?? `${noun}s`}</>
        ) : (
          <>
            Showing <span className="font-semibold">{first.toLocaleString("en-PH")}</span>–
            <span className="font-semibold">{last.toLocaleString("en-PH")}</span> of{" "}
            {approximate ? "about " : null}
            <span className="font-semibold">{total.toLocaleString("en-PH")}</span>{" "}
            {total === 1 ? noun : (plural ?? `${noun}s`)}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span
            id="page-size-label"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Rows
          </span>
          <span className="flex gap-1" role="group" aria-labelledby="page-size-label">
            {sizeOptions.map((o) => (
              <Link
                key={o.size}
                href={o.href}
                aria-current={o.size === size ? "true" : undefined}
                className={`min-h-11 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                  o.size === size
                    ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] font-semibold text-white"
                    : "border-[color:var(--color-brand-bg-mid)] hover:border-[color:var(--color-brand-cyan)]"
                }`}
              >
                {o.size}
              </Link>
            ))}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-[color:var(--color-brand-text-soft)]">
            Page {page} of {pageCount}
          </span>
          <PagerLink href={prevHref} label="← Previous" />
          <PagerLink href={nextHref} label="Next →" />
        </div>
      </div>
    </nav>
  );
}

/** A disabled edge renders as inert text, not a dead link. */
function PagerLink({ href, label }: { href: string | null; label: string }) {
  const base =
    "min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm";
  if (!href) {
    return (
      <span
        aria-disabled="true"
        className={`${base} text-[color:var(--color-brand-text-soft)] opacity-50`}
      >
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className={`${base} transition-colors hover:border-[color:var(--color-brand-cyan)]`}>
      {label}
    </Link>
  );
}

export { PAGE_SIZES };
