import Link from "next/link";

export interface ActivityItem {
  primary: string;
  secondary?: string;
  meta?: string;
  href?: string;
}

interface ActivityStripProps {
  title: string;
  items: ActivityItem[];
  emptyMessage?: string;
  viewAllHref?: string;
  // The strip's own query failed. An empty list on a dashboard used to mean
  // either "nothing waiting" or "the query blew up"; the strip could not tell
  // the two apart, so a failed read rendered as a reassuring all-clear. When
  // this is set the strip says so instead, and `emptyMessage` is ignored.
  error?: boolean;
}

export function ActivityStrip({
  title,
  items,
  emptyMessage,
  viewAllHref,
  error = false,
}: ActivityStripProps) {
  return (
    <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="font-heading text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          {title}
        </h3>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="text-xs font-medium text-[color:var(--color-brand-cyan)] hover:underline"
          >
            View all
          </Link>
        ) : null}
      </header>
      {error ? (
        <p className="py-3 text-sm font-medium text-amber-700">
          Couldn&apos;t load — this list is unknown, not empty. Reload the page.
        </p>
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-[color:var(--color-brand-text-soft)]">
          {emptyMessage ?? "Nothing here."}
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {items.map((item, idx) => {
            const rowBody = (
              <div className="flex items-baseline justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[color:var(--color-brand-text)]">
                    {item.primary}
                  </p>
                  {item.secondary ? (
                    <p className="truncate text-xs text-[color:var(--color-brand-text-soft)]">
                      {item.secondary}
                    </p>
                  ) : null}
                </div>
                {item.meta ? (
                  <span className="shrink-0 text-xs text-[color:var(--color-brand-text-soft)]">
                    {item.meta}
                  </span>
                ) : null}
              </div>
            );
            return (
              <li key={idx}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className="block rounded-md transition-colors hover:bg-[color:var(--color-brand-bg)]"
                  >
                    {rowBody}
                  </Link>
                ) : (
                  rowBody
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
