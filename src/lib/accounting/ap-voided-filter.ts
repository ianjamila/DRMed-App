/**
 * Voided rows on the AP Bills and Bill Payments lists are hidden unless the
 * viewer asks for them with `?voided=1`.
 *
 * Every row both lists held on prod in 2026-09 was a voided duplicate from the
 * June books reconciliation, so the lists opened on 75 greyed-out rows that
 * made it look as if something had gone wrong. A voided row is kept for the
 * audit trail, not for day-to-day work, so it is hidden by default, and the
 * number hidden is always shown so nothing drops out of view without notice.
 *
 * The filter runs over the rows already fetched rather than in the query. The
 * lists page and sort in the browser over one fetched set, so the hidden
 * count comes free, and the AP_INDEX_MAX_ROWS truncation notice still
 * describes what was actually fetched.
 */

export const SHOW_VOIDED_PARAM = "voided";

export function parseShowVoided(value: string | null | undefined): boolean {
  return value === "1";
}

export function splitVoided<T>(
  rows: readonly T[],
  isVoided: (row: T) => boolean,
  showVoided: boolean,
): { visible: T[]; hiddenVoided: number } {
  if (showVoided) return { visible: [...rows], hiddenVoided: 0 };
  const visible = rows.filter((r) => !isVoided(r));
  return { visible, hiddenVoided: rows.length - visible.length };
}
