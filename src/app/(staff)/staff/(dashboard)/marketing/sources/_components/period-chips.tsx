/**
 * Period preset pills for the Booking Sources report — same look as
 * financial-statements' `PeriodPresets`, but reading/writing `?from=&to=`
 * (this report's own param names, matching the Operations daily report's
 * `DateControls`) instead of `?start=&end=`. Kept local rather than
 * importing that sibling component so this page's URL contract doesn't
 * depend on another feature's route staying in sync with it.
 *
 * The calendar arithmetic lives in `@/lib/reports/period-presets` so it's
 * unit-tested there already — see the M2 note on that module for why it
 * must never touch `Date`.
 */
import Link from "next/link";
import { buildPeriodPresets } from "@/lib/reports/period-presets";

export function PeriodChips({
  pathname,
  from,
  to,
  todayISO,
}: {
  pathname: string;
  from: string;
  to: string;
  todayISO: string;
}) {
  const presets = buildPeriodPresets(todayISO);
  const activeKey = presets.find((p) => p.start === from && p.end === to)?.key ?? null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Period
      </span>
      {presets.map((p) => {
        const active = p.key === activeKey;
        const href = `${pathname}?from=${p.start}&to=${p.end}`;
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
    </div>
  );
}
