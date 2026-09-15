/**
 * Quick-period presets for the financial statements — pure calendar logic, so
 * the "which month is it?" arithmetic is unit-testable away from the JSX.
 *
 * M2: these used to build `new Date(`${todayISO}T00:00:00+08:00`)` and then read
 * `getUTCFullYear()` / `getUTCMonth()` back out. Stamping +08:00 is right —
 * reading UTC components off the result is not, because Manila midnight is
 * 16:00 UTC the PREVIOUS day. On the 1st of any month the UTC month was the
 * month before, so "This month" returned last month, "Last month" returned the
 * one before that, and on 1 January "Year-to-date" returned the whole of last
 * year. Correct on the 2nd–31st, wrong on precisely the day someone opens these
 * to close the books. Everything here now works off the YYYY-MM-DD string's own
 * integers via the `manila.ts` helpers — no `Date` in the path at all.
 */
import { firstOfMonthISO, isoDateParts, lastOfMonthISO } from "@/lib/dates/manila";

export interface PeriodPreset {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface AsOfPreset {
  key: string;
  label: string;
  date: string;
}

/** start/end presets for the Income statement and Cash flow. */
export function buildPeriodPresets(todayISO: string): PeriodPreset[] {
  const { year, month } = isoDateParts(todayISO);

  return [
    {
      key: "this-month",
      label: "This month",
      start: firstOfMonthISO(year, month),
      end: todayISO,
    },
    {
      key: "last-month",
      label: "Last month",
      start: firstOfMonthISO(year, month - 1),
      end: lastOfMonthISO(year, month - 1),
    },
    { key: "ytd", label: "Year-to-date", start: firstOfMonthISO(year, 1), end: todayISO },
    {
      key: "this-year",
      label: `This year (${year})`,
      start: firstOfMonthISO(year, 1),
      end: lastOfMonthISO(year, 12),
    },
    {
      key: "last-year",
      label: `Last year (${year - 1})`,
      start: firstOfMonthISO(year - 1, 1),
      end: lastOfMonthISO(year - 1, 12),
    },
    {
      // Inclusive of the current month, so "last 12 months" is 12 month columns.
      key: "12m",
      label: "Last 12 months",
      start: firstOfMonthISO(year, month - 11),
      end: todayISO,
    },
  ];
}

/** as_of presets for the Balance sheet — a closing date, not a range. */
export function buildAsOfPresets(todayISO: string): AsOfPreset[] {
  const { year, month } = isoDateParts(todayISO);
  // Month 1-12 → quarter-start month 1, 4, 7, 10; the day before that is the
  // end of the previous quarter.
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;

  return [
    { key: "today", label: "Today", date: todayISO },
    { key: "prev-month", label: "End of last month", date: lastOfMonthISO(year, month - 1) },
    {
      key: "prev-q",
      label: "End of last quarter",
      date: lastOfMonthISO(year, quarterStartMonth - 1),
    },
    { key: "prev-year", label: `End of ${year - 1}`, date: lastOfMonthISO(year - 1, 12) },
    { key: "two-years", label: `End of ${year - 2}`, date: lastOfMonthISO(year - 2, 12) },
  ];
}

/**
 * The (start, end) covering the same span ending one year earlier — the
 * prior-year comparison column. E.g. (2026-01-01 → 2026-05-28) becomes
 * (2025-01-01 → 2025-05-28).
 *
 * 29 February is clamped to the 28th: the un-clamped shift produced
 * "2027-02-29", which passes the `isISODate` regex guard and is then silently
 * rolled over to 1 March by `new Date()`, shifting the comparison by a day.
 */
export function priorYearRange(start: string, end: string): { start: string; end: string } {
  const shift = (iso: string) => {
    const { year, month, day } = isoDateParts(iso);
    const priorYear = year - 1;
    const lastDay = Number(lastOfMonthISO(priorYear, month).slice(-2));
    return `${priorYear}-${String(month).padStart(2, "0")}-${String(
      Math.min(day, lastDay),
    ).padStart(2, "0")}`;
  };
  return { start: shift(start), end: shift(end) };
}
