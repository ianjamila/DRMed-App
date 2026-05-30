import type { ReactNode } from "react";

/** Standard empty-state card (dashed border, centered). For page-level empties. */
export function EmptyState({
  title,
  description,
  action,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-10 text-center ${className}`}
    >
      <p className="font-semibold text-[color:var(--color-brand-navy)]">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
