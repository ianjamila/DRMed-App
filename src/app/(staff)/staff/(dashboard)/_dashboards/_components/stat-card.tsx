import Link from "next/link";

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  accent?: "default" | "warn" | "good";
}

export function StatCard({ label, value, hint, href, accent = "default" }: StatCardProps) {
  const valueColor =
    accent === "warn"
      ? "text-[color:var(--color-brand-navy)]"
      : accent === "good"
        ? "text-[color:var(--color-brand-navy)]"
        : "text-[color:var(--color-brand-navy)]";

  const accentBar =
    accent === "warn"
      ? "before:bg-amber-400"
      : accent === "good"
        ? "before:bg-emerald-400"
        : "before:bg-[color:var(--color-brand-cyan)]";

  const body = (
    <>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-2 font-heading text-3xl font-extrabold ${valueColor}`}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{hint}</p>
      ) : null}
    </>
  );

  const baseClass = `relative block overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accentBar}`;

  if (href) {
    return (
      <Link
        href={href}
        className={`${baseClass} transition-colors hover:border-[color:var(--color-brand-cyan)] hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]`}
      >
        {body}
      </Link>
    );
  }

  return <article className={baseClass}>{body}</article>;
}
