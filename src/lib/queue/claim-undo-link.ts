// The URL handshake between the queue row's panel Claim and the report page's
// Undo notice: `?claimed=<batch>&at=<ms>`. Pure so both ends — and the tests —
// share one definition. Nothing here grants anything: Undo re-proves actor,
// window and state server-side from the audit rows.

const UUID_SHAPE = /^[0-9a-f-]{36}$/i;

/** The report page URL for a panel, carrying its Undo batch when it has one. */
export function claimReportHref(
  panel: { visitId: string; groupId: string },
  batchId: string | undefined,
  nowMs: number,
): string {
  const base = `/staff/queue/consolidated/${panel.visitId}/${panel.groupId}`;
  return batchId ? `${base}?claimed=${encodeURIComponent(batchId)}&at=${nowMs}` : base;
}

type Param = string | string[] | undefined;

/**
 * Reads `claimed` / `at` off a report page's searchParams. A batch id that is
 * not uuid-shaped is dropped. A missing, empty, malformed or future `at`
 * counts as "just now" — it only paces the Undo button.
 */
export function parseClaimUndoParams(
  sp: { claimed?: Param; at?: Param },
  nowMs: number,
): { batchId: string | null; doneAt: number } {
  const batchId = typeof sp.claimed === "string" && UUID_SHAPE.test(sp.claimed) ? sp.claimed : null;
  const raw = typeof sp.at === "string" ? sp.at.trim() : "";
  const at = raw === "" ? NaN : Number(raw);
  return { batchId, doneAt: Number.isFinite(at) && at <= nowMs ? at : nowMs };
}
