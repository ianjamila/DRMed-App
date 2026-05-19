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
 * payroll periods). Year appears once at the end; if the two dates span
 * calendar years (rare) the end-year still keeps the user oriented.
 */
export function formatPeriodRange(startISO: string, endISO: string): string {
  if (!startISO || !endISO) return "—";
  // Parse as Manila wall-clock by appending the +08:00 offset.
  const start = new Date(`${startISO}T00:00:00+08:00`);
  const end = new Date(`${endISO}T00:00:00+08:00`);
  return `${RANGE_FMT.format(start)} – ${RANGE_FMT.format(end)}, ${YEAR_FMT.format(end)}`;
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
