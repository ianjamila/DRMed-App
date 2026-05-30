import Link from "next/link";

interface PlannedCardProps {
  label: string;
  teaser: string;
  module?: string;
}

export function PlannedCard({ label, teaser, module }: PlannedCardProps) {
  const body = (
    <>
      <span className="absolute right-3 top-3 rounded-full bg-[color:var(--color-brand-cyan)]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        Planned
      </span>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-heading text-2xl font-bold text-[color:var(--color-brand-navy)]/60">
        —
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{teaser}</p>
    </>
  );

  const baseClass =
    "relative block rounded-xl border border-dashed border-[color:var(--color-brand-cyan-light)] bg-[color:var(--color-brand-bg)] p-5";

  if (module) {
    return (
      <Link
        href={`/staff/admin/coming-soon/${module}`}
        className={`${baseClass} transition-colors hover:border-[color:var(--color-brand-cyan)] hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]`}
      >
        {body}
      </Link>
    );
  }

  return <article className={baseClass}>{body}</article>;
}
