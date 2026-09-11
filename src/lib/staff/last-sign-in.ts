/**
 * Human-readable "last signed in" for the staff users list.
 *
 * The absolute timestamp is still rendered next to it — this is the line an
 * admin scans to spot a dormant account, where "3 months ago" answers the
 * question and "11 Jun 2026, 3:25 PM" makes them do arithmetic.
 *
 * `now` is a parameter so the buckets are testable without faking the clock.
 */
export function relativeSignIn(
  iso: string | null | undefined,
  now: Date,
): string {
  if (!iso) return "Never";

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";

  // Clock skew between the browser, the server and Postgres can put a stamp
  // slightly in the future; that must never render as "-3 min ago".
  const elapsed = Math.max(0, now.getTime() - then);

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}
