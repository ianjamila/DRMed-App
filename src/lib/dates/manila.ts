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
