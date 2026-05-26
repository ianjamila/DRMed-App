interface DashboardHeaderProps {
  firstName: string;
  roleLabel: string;
  title: string;
}

export function DashboardHeader({ firstName, roleLabel, title }: DashboardHeaderProps) {
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          Welcome back, {firstName}
        </p>
        <span className="inline-flex items-center rounded-full border border-[color:var(--color-brand-cyan-light)] bg-[color:var(--color-brand-cyan)]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          {roleLabel}
        </span>
      </div>
      <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h1>
    </header>
  );
}
