import { buildListHref } from "@/lib/ui/table-params";

/**
 * Where the lab queue sends reception. Reception only ever sees "Released
 * today" (owner decision 2026-09-24), so any other tab redirects there — but a
 * link that carried a search, visit #, date range, page size or sort must keep
 * them, or the counter lands on today's whole list instead of the patient it
 * was looking for. The page number is dropped (it belonged to another tab's
 * list) and so is `mine`, which only means something to the lab.
 */
const CARRIED = ["q", "visit", "start", "end", "size", "sort", "dir"] as const;

export function receptionQueueHref(params: Record<string, string | undefined>): string {
  const kept: Record<string, string | null> = { filter: "released_today" };
  for (const key of CARRIED) kept[key] = params[key]?.trim() || null;
  return buildListHref("/staff/queue", kept);
}
