import type { ReactNode } from "react";

/** Standard staff-page header: title (+ optional subtitle) on the left,
 *  optional actions on the right. Replaces the inline h1+subtitle block
 *  copy-pasted across ~100 pages. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
