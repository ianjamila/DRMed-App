// The lab queue's Remarks column: a test's claim history (claimed, unclaimed,
// reassigned) and its edits after it was finished, turned into short
// plain-English lines. The rows come from the queue_claim_remarks (0160) and
// result_amendment_remarks (0176) RPCs, which share one row shape; this module
// is pure so it can be tested without a database.
//
// An edit reads "Updated <when> by <who> — “reason”" (owner decision
// 2026-09-25): clinic-only — never on the PDF or the portal, and the RPC gives
// reception no rows.

import { manilaDateTime } from "@/lib/dates/manila";

export interface ClaimEvent {
  test_request_id: string;
  action: string;
  created_at: string;
  actor_name: string | null;
  previous_holder_name: string | null;
  new_holder_name: string | null;
  reason: string | null;
}

export interface ClaimRemark {
  /** Stable React key. */
  key: string;
  text: string;
  at: string;
  /** Unclaims, reassignments and edits are the "something happened" rows. */
  notable: boolean;
  /** The text already says when (an edit) — the list doesn't repeat it. */
  timeInText?: boolean;
}

/** Action name result_amendment_remarks (0176) returns for an edit. */
export const RESULT_AMENDED_ACTION = "result.amended";

// A queue row shows at most this many lines; older ones fold into "+N earlier".
export const MAX_REMARKS_SHOWN = 3;

const SOMEONE = "someone";

function describe(
  e: ClaimEvent,
): { text: string; notable: boolean; timeInText?: boolean } | null {
  const actor = e.actor_name ?? SOMEONE;
  const reason = e.reason ? ` — “${e.reason}”` : "";
  switch (e.action) {
    case "test_request.claimed":
    case "test_request.claim":
      return { text: `Claimed by ${actor}`, notable: false };
    case "test_request.unclaimed": {
      const prev = e.previous_holder_name;
      // Self-service unclaim: the holder handed it back. Otherwise an admin
      // took someone else's claim off them — name both.
      const text =
        !prev || prev === e.actor_name
          ? `Unclaimed by ${actor}`
          : `${actor} unclaimed ${prev}’s claim`;
      return { text: text + reason, notable: true };
    }
    case "test_request.reassigned":
      return {
        text: `Reassigned ${e.previous_holder_name ?? SOMEONE} → ${e.new_holder_name ?? SOMEONE} by ${actor}`,
        notable: true,
      };
    case RESULT_AMENDED_ACTION:
      return {
        text: `Updated ${manilaDateTime(e.created_at)} by ${actor}${reason}`,
        notable: true,
        timeInText: true,
      };
    default:
      return null;
  }
}

/**
 * Remarks for ONE queue row. A consolidated chemistry card passes the events
 * of every member test; a group claim/unclaim writes one event per member, so
 * those collapse to a single line here (same action, actor and minute).
 * Oldest first — the column reads as a story.
 */
export function claimRemarks(events: readonly ClaimEvent[]): ClaimRemark[] {
  const sorted = [...events].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      a.action.localeCompare(b.action) ||
      a.test_request_id.localeCompare(b.test_request_id),
  );
  const seen = new Set<string>();
  const out: ClaimRemark[] = [];
  for (const e of sorted) {
    const d = describe(e);
    if (!d) continue;
    const dedupe = `${d.text}|${e.created_at.slice(0, 16)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      key: `${e.test_request_id}|${e.action}|${e.created_at}`,
      text: d.text,
      at: e.created_at,
      notable: d.notable,
      ...(d.timeInText ? { timeInText: true } : {}),
    });
  }
  return out;
}

/** Group RPC rows by test id. */
export function eventsByTest(
  rows: readonly ClaimEvent[] | null | undefined,
): Map<string, ClaimEvent[]> {
  const map = new Map<string, ClaimEvent[]>();
  for (const r of rows ?? []) {
    const list = map.get(r.test_request_id);
    if (list) list.push(r);
    else map.set(r.test_request_id, [r]);
  }
  return map;
}

export interface HandedBack {
  /** How many times the test was unclaimed. */
  count: number;
  /** The most recent unclaim, already worded ("Unclaimed by … — “reason”"). */
  latest: ClaimRemark;
}

/**
 * Has this test ever been handed back to the queue? Drives the Visit page's
 * "handed back" chip. Only UNCLAIMS count — a reassignment moves the work to a
 * named person, it never puts it back up for grabs.
 */
export function handedBack(events: readonly ClaimEvent[]): HandedBack | null {
  const unclaims = claimRemarks(
    events.filter((e) => e.action === "test_request.unclaimed"),
  );
  if (unclaims.length === 0) return null;
  return { count: unclaims.length, latest: unclaims[unclaims.length - 1] };
}
