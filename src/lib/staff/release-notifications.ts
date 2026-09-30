// Pure folding rules for the reception bell's "results released" items.
// No React, no Supabase — the bell feeds Realtime rows in and renders what
// comes out. Kept here so the dedupe and merge rules are unit-testable.

import { manilaTime } from "@/lib/dates/manila";

/** A release event, already resolved to display names by the bell. */
export interface ReleaseEvent {
  testRequestId: string;
  /** `test_requests.released_at` of the row that fired the event. */
  releasedAt: string;
  visitId: string;
  /** "Last, First" — reception's own in-app bell, not an email. */
  who: string;
  visitNumber: string;
  /** Client clock when the event arrived (ms). */
  ts: number;
}

/** The slice of a bell item this module reads and writes. */
export interface ReleaseFoldItem {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  href: string;
  ts: number;
  count?: number;
  visitId?: string;
}

export interface ReleaseFoldState<T extends ReleaseFoldItem> {
  items: T[];
  seen: Set<string>;
}

/** Releases of one visit closer together than this share one bell item. */
export const RELEASE_MERGE_WINDOW_MS = 60_000;
const RELEASE_HREF = "/staff/queue?filter=released_today";

/** One release = one test at one release instant; a later UPDATE of the same
 *  row (remarks, claim…) carries the same key and is a repeat. */
export function releaseEventKey(ev: Pick<ReleaseEvent, "testRequestId" | "releasedAt">): string {
  return `${ev.testRequestId}@${ev.releasedAt}`;
}

/** Realtime UPDATE payloads carry no old row (default replica identity), so
 *  "just released" is judged from `released_at` itself. */
export function isFreshRelease(
  row: { status: string; released_at: string | null },
  now: number,
  windowMs = 120_000,
): boolean {
  if (row.status !== "released" || !row.released_at) return false;
  const at = Date.parse(row.released_at);
  if (Number.isNaN(at)) return false;
  return now - at <= windowMs;
}

function releaseTitle(count: number, who: string): string {
  return `${count} ${count === 1 ? "result" : "results"} released for ${who}`;
}

export function foldReleaseEvent<T extends ReleaseFoldItem>(
  state: ReleaseFoldState<T>,
  ev: ReleaseEvent,
): ReleaseFoldState<T> & { isNew: boolean } {
  const key = releaseEventKey(ev);
  if (state.seen.has(key)) return { ...state, isNew: false };
  const seen = new Set(state.seen).add(key);

  // Newest item for this visit, if it is still inside the merge window.
  const idx = state.items.findIndex(
    (i) => i.kind === "release" && i.visitId === ev.visitId,
  );
  if (idx !== -1 && ev.ts - state.items[idx].ts <= RELEASE_MERGE_WINDOW_MS) {
    const count = (state.items[idx].count ?? 1) + 1;
    const items = state.items.slice();
    items[idx] = { ...items[idx], count, title: releaseTitle(count, ev.who) };
    return { items, seen, isNew: true };
  }

  // Cast: the bell's item type is a superset of ReleaseFoldItem; the extra
  // fields (severity) are optional there.
  const item = {
    id: `released-${ev.visitId}-${ev.ts}`,
    kind: "release",
    title: releaseTitle(1, ev.who),
    subtitle: `Visit #${ev.visitNumber} · ${manilaTime(new Date(ev.ts))}`,
    href: RELEASE_HREF,
    ts: ev.ts,
    count: 1,
    visitId: ev.visitId,
  } as T;
  return { items: [item, ...state.items], seen, isNew: true };
}
