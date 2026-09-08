/**
 * The one "Export CSV" control. A plain anchor on purpose: the target is a
 * Route Handler download, which must not go through next/link's client
 * navigation — and next/link would PREFETCH it on hover/viewport, firing the
 * route's `*.exported` audit row without anyone exporting anything.
 * Server-safe (no hooks), usable from any RSC.
 */
export function ExportCsvLink({
  href,
  label = "Export CSV",
}: {
  href: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2"
    >
      {label}
    </a>
  );
}
