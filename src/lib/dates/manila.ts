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

/**
 * THE canonical short date for staff screens: "Sep 11, 2026".
 *
 * Staff pages used to mix `toLocaleDateString()` (which renders "9/11/2026" on
 * an en-US runtime) with ad-hoc `Intl` options, so the same visit read as a
 * different date depending on which page you were on. For a PH clinic a
 * numeric day/month order is genuinely ambiguous — 9/11 is either 9 November
 * or 11 September — so the house format always spells the month.
 *
 * Month-first with a spelled month, matching `friendlyManilaDate` above and
 * the appointments list — the two places the app already had it right. Note
 * en-GB is NOT equivalent: it yields "11 Sept 2026", day-first and with a
 * four-letter "Sept" that reads inconsistently beside every other surface.
 *
 * Accepts a YYYY-MM-DD calendar date or a timestamptz ISO string; both are
 * rendered in Asia/Manila.
 */
export function manilaDate(value: string | Date | null | undefined): string {
  const d = toManilaInstant(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: MANILA_TZ,
  }).format(d);
}

/** The canonical date + time: "Sep 11, 2026, 2:06 PM". */
export function manilaDateTime(value: string | Date | null | undefined): string {
  const d = toManilaInstant(value);
  if (!d) return "—";
  const date = manilaDate(d);
  return `${date}, ${manilaTime(d)}`;
}

/** The canonical clock time alone: "2:06 PM". */
export function manilaTime(value: string | Date | null | undefined): string {
  const d = toManilaInstant(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: MANILA_TZ,
  }).format(d);
}

/**
 * Normalise the two shapes staff pages actually hold to an instant.
 *
 * A bare YYYY-MM-DD is a Manila CALENDAR date, not an instant — parsing it with
 * `new Date()` reads it as UTC midnight, which is 8am Manila the same day but
 * renders as the PREVIOUS day for anyone formatting in a westward zone. Pinning
 * it to Manila noon keeps it on its own calendar day under any formatter.
 */
function toManilaInstant(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = isISODate(value)
    ? new Date(`${value}T12:00:00+08:00`)
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
