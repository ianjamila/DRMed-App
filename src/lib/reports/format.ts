/** Presentation helpers shared by report loaders, pages and CSV routes. Pure. */

const MANILA_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD HH:mm` in Asia/Manila — sorts as text and Excel parses it. */
export function csvManilaStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const parts = MANILA_STAMP.formatToParts(t);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * PostgREST returns an embedded relation as an object or a one-element array
 * depending on the join shape. One copy of the flattener — the report pages
 * used to carry four private ones.
 */
export function pluckOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
