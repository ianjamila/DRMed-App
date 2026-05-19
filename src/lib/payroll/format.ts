// Shared payroll-period formatter. Used by the periods index, the run review
// header, and any other surface that needs to label a pay period.

const RANGE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
});

const YEAR_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
});

/**
 * Format a period range as "May 1 – May 15, 2026" (or "Apr 16 – May 15, 2026"
 * when the range crosses a month boundary, which is common for half-month
 * payroll periods). When the period crosses a calendar year (Dec 26 – Jan 8)
 * both years are shown so the reader stays oriented: "Dec 26, 2026 – Jan 8,
 * 2027".
 */
export function formatPeriodRange(startISO: string, endISO: string): string {
  if (!startISO || !endISO) return "—";
  // Parse as Manila wall-clock by appending the +08:00 offset.
  const start = new Date(`${startISO}T00:00:00+08:00`);
  const end = new Date(`${endISO}T00:00:00+08:00`);
  const startYear = YEAR_FMT.format(start);
  const endYear = YEAR_FMT.format(end);
  if (startYear !== endYear) {
    return `${RANGE_FMT.format(start)}, ${startYear} – ${RANGE_FMT.format(end)}, ${endYear}`;
  }
  return `${RANGE_FMT.format(start)} – ${RANGE_FMT.format(end)}, ${endYear}`;
}

const FULL_DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Format a YYYY-MM-DD string as "May 20, 2026" in Asia/Manila. */
export function formatManilaDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return FULL_DATE_FMT.format(new Date(`${iso}T00:00:00+08:00`));
}
