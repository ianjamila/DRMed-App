interface PlannedCardProps {
  label: string;
  teaser: string;
}

export function PlannedCard({ label, teaser }: PlannedCardProps) {
  return (
    <article className="relative rounded-xl border border-dashed border-[color:var(--color-brand-cyan-light)] bg-[color:var(--color-brand-bg)] p-5">
      <span className="absolute right-3 top-3 rounded-full bg-[color:var(--color-brand-cyan)]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        Planned
      </span>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-bold text-[color:var(--color-brand-navy)]/60">
        —
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{teaser}</p>
    </article>
  );
}
