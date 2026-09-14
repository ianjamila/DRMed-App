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

/**
 * The long-form date, "September 11, 2026" — for the few places a date is the
 * page's headline rather than a cell in a table (the patient portal's visit
 * header). Same normalisation as `manilaDate`, so a bare YYYY-MM-DD cannot
 * slide to the previous day the way `new Date("2026-09-11")` does in a
 * westward zone.
 */
export function manilaLongDate(value: string | Date | null | undefined): string {
  const d = toManilaInstant(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
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

// ---------------------------------------------------------------------------
// Manila calendar arithmetic — integers and strings only, never a Date
// ---------------------------------------------------------------------------
// A YYYY-MM-DD Manila date is a CALENDAR date, not an instant, so month/year
// arithmetic on it must never round-trip through `Date`. The financial-statement
// presets used to do exactly that: they stamped `${todayISO}T00:00:00+08:00`
// (correctly pinning Manila midnight) and then read `getUTCFullYear()` /
// `getUTCMonth()` back out — but Manila midnight is 16:00 UTC the *previous*
// day, so on the 1st of any month the UTC month was the month before. "This
// month" returned last month, and on 1 January "Year-to-date" returned the
// whole previous year — on precisely the day someone opens those presets to
// close the books. Parsing the string into integers removes the class of bug.

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Proleptic Gregorian leap year. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Fold a (year, month) pair whose month falls outside 1-12 into the
 * neighbouring year, so callers can say "11 months back" as `month - 11` and
 * not hand-roll the December wrap.
 */
function normaliseMonth(year: number, month: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1);
  return { year: Math.floor(idx / 12), month: (((idx % 12) + 12) % 12) + 1 };
}

/** Calendar parts of a YYYY-MM-DD Manila date. `month` is 1-12, not 0-11. */
export function isoDateParts(isoDate: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = isoDate.split("-").map(Number);
  return { year, month, day };
}

/** Days in (year, month), leap years included. Month may be outside 1-12. */
export function daysInMonth(year: number, month: number): number {
  const n = normaliseMonth(year, month);
  return n.month === 2 && isLeapYear(n.year) ? 29 : DAYS_IN_MONTH[n.month - 1];
}

/** YYYY-MM-DD for the 1st of (year, month). Month may be outside 1-12. */
export function firstOfMonthISO(year: number, month: number): string {
  const n = normaliseMonth(year, month);
  return `${n.year}-${pad2(n.month)}-01`;
}

/** YYYY-MM-DD for the last day of (year, month). Month may be outside 1-12. */
export function lastOfMonthISO(year: number, month: number): string {
  const n = normaliseMonth(year, month);
  return `${n.year}-${pad2(n.month)}-${pad2(daysInMonth(n.year, n.month))}`;
}
