/**
 * Period preset pills for Send-out Labs — same shape as Financial Statements'
 * (this month / last month / YTD / this year / last year / last 12 mo /
 * custom), duplicated locally rather than imported because each report route
 * owns its own `_components` (see `financial-statements/_components`). Plain
 * `<a>`-backed `Link`s, so this stays a Server Component with no client JS.
 */
import Link from "next/link";
import { buildPeriodPresets } from "@/lib/reports/period-presets";

export function PeriodPresets({
  pathname,
  start,
  end,
  todayISO,
}: {
  pathname: string;
  start: string;
  end: string;
  todayISO: string;
}) {
  const presets = buildPeriodPresets(todayISO);
  const activeKey = presets.find((p) => p.start === start && p.end === end)?.key ?? null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Quick periods
      </span>
      {presets.map((p) => {
        const active = p.key === activeKey;
        const href = `${pathname}?start=${p.start}&end=${p.end}`;
        return (
          <Link
            key={p.key}
            href={href}
            className={
              "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider " +
              (active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]")
            }
          >
            {p.label}
          </Link>
        );
      })}
      <span className="text-[10px] text-[color:var(--color-brand-text-soft)]">
        or pick custom dates below
      </span>
    </div>
  );
}
