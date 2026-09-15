/**
 * Period preset pills for financial statements. Renders as a row of pills
 * (this month / last month / YTD / this year / last year / last 12 mo / custom).
 * Each pill is a link that drops in the right start/end into the URL — works
 * as plain `<a>` so it stays a Server Component and there is no client JS.
 *
 * The calendar arithmetic lives in `@/lib/reports/period-presets` so it can be
 * unit-tested — see the M2 note there for why it must never touch `Date`.
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
