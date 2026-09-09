const exportCsvClassName =
  "min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2";

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
    <a href={href} className={exportCsvClassName}>
      {label}
    </a>
  );
}

/**
 * The same "Export CSV" control as `ExportCsvLink`, for sites that build a
 * CSV client-side from rows already in the browser (a `Blob` download) —
 * there's no Route Handler to link to, so this renders as a `<button>`
 * instead of an anchor. `type="button"` is required: some adoption sites
 * live inside a `<form>`, and a bare `<button>` would submit it.
 */
export function ExportCsvButton({
  onClick,
  label = "Export CSV",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={exportCsvClassName}>
      {label}
    </button>
  );
}
