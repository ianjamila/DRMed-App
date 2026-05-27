/**
 * Period preset pills for financial statements. Renders as a row of pills
 * (this month / last month / YTD / this year / last year / last 12 mo / custom).
 * Each pill is a link that drops in the right start/end into the URL — works
 * as plain `<a>` so it stays a Server Component and there's no client JS.
 */
import Link from "next/link";

interface Preset {
  key: string;
  label: string;
  start: string;
  end: string;
}

export function buildPresets(todayISO: string): Preset[] {
  const today = new Date(`${todayISO}T00:00:00+08:00`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-11
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const firstOfMonth = (yr: number, mo: number) => new Date(Date.UTC(yr, mo, 1));
  const lastOfMonth = (yr: number, mo: number) => new Date(Date.UTC(yr, mo + 1, 0));
  const lastDayOf = (yr: number) => new Date(Date.UTC(yr, 11, 31));

  const lastMonthYear = m === 0 ? y - 1 : y;
  const lastMonthMonth = m === 0 ? 11 : m - 1;

  // 12 months back (inclusive of current month)
  const twelveBack = firstOfMonth(y, m - 11);

  return [
    { key: "this-month", label: "This month", start: iso(firstOfMonth(y, m)), end: todayISO },
    { key: "last-month", label: "Last month", start: iso(firstOfMonth(lastMonthYear, lastMonthMonth)), end: iso(lastOfMonth(lastMonthYear, lastMonthMonth)) },
    { key: "ytd", label: "Year-to-date", start: iso(firstOfMonth(y, 0)), end: todayISO },
    { key: "this-year", label: `This year (${y})`, start: iso(firstOfMonth(y, 0)), end: iso(lastDayOf(y)) },
    { key: "last-year", label: `Last year (${y - 1})`, start: iso(firstOfMonth(y - 1, 0)), end: iso(lastDayOf(y - 1)) },
    { key: "12m", label: "Last 12 months", start: iso(twelveBack), end: todayISO },
  ];
}

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
  const presets = buildPresets(todayISO);
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

// Returns the (start, end) covering the same span ending one year earlier.
// E.g., (2026-01-01 → 2026-05-28) becomes (2025-01-01 → 2025-05-28).
export function priorYearRange(start: string, end: string): { start: string; end: string } {
  const shift = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  return { start: shift(start), end: shift(end) };
}
