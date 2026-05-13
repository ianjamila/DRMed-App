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
