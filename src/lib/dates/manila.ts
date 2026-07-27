const MANILA_TZ = "Asia/Manila";

/** Returns YYYY-MM-DD for the current date in Asia/Manila. */
export function todayManilaISODate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** YYYY-MM-DD <= today (Manila). Used by Zod refinements and date-input max attrs. */
export function isOnOrBeforeTodayManila(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return dateStr <= todayManilaISODate();
}

/**
 * True when the value is a well-formed YYYY-MM-DD string. Every staff page that
 * reads a date out of `searchParams` has to reject junk before it reaches a
 * query — this is that guard, so the regex isn't re-declared per page.
 */
export function isISODate(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Shift a YYYY-MM-DD calendar date by whole days (negative = earlier). Pure
 * string→string, so it's safe for prev/next-day links in Server Components.
 */
export function shiftISODate(dateStr: string, days: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * UTC instants bounding an INCLUSIVE Manila calendar-day range, for filtering
 * `timestamptz` columns: `fromIso` is Manila midnight on `startDate`, `toIso`
 * is Manila midnight the day AFTER `endDate`. Filter with `gte(fromIso)` +
 * `lt(toIso)` — a half-open window can't drop the last second of the end day
 * the way a naive `${end}T23:59:59` bound does.
 *
 * Either side may be blank/invalid to leave that bound open (returns null).
 * Naive bounds like `${date}T00:00:00` are NOT equivalent: Postgres reads them
 * in the server's zone (UTC in production), shifting every boundary 8 hours.
 */
export function manilaRangeUtc(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): { fromIso: string | null; toIso: string | null } {
  return {
    fromIso: isISODate(startDate)
      ? new Date(`${startDate}T00:00:00+08:00`).toISOString()
      : null,
    toIso: isISODate(endDate)
      ? new Date(`${shiftISODate(endDate, 1)}T00:00:00+08:00`).toISOString()
      : null,
  };
}

/** "Monday, July 27, 2026" for a YYYY-MM-DD Manila date — day headers. */
export function friendlyManilaDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: MANILA_TZ,
  }).format(d);
  const longDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: MANILA_TZ,
  }).format(d);
  return `${weekday}, ${longDate}`;
}

/**
 * UTC [start, end) ISO instants for the Manila calendar day `offsetDays` from
 * today. PH is a fixed UTC+8 (no DST), so a Manila midnight maps via a literal
 * +08:00 offset. Used by the day-before reminder cron (offsetDays = 1).
 */
export function manilaDayWindowUtc(offsetDays: number): {
  startIso: string;
  endIso: string;
} {
  const base = Date.parse(`${todayManilaISODate()}T00:00:00+08:00`);
  const start = base + offsetDays * 86_400_000;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + 86_400_000).toISOString(),
  };
}
