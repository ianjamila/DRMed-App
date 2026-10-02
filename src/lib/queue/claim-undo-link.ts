// The URL handshake between the queue row's panel Claim and the report page's
// Undo notice: `?claimed=<batch>&at=<ms>`. Pure so both ends — and the tests —
// share one definition. Nothing here grants anything: Undo re-proves actor,
// window and state server-side from the audit rows.

import { UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";

const UUID_SHAPE = /^[0-9a-f-]{36}$/i;

/** `base` plus `?claimed=<batch>&at=<ms>` when there is a batch, else `base` alone. */
function withClaimQuery(base: string, batchId: string | undefined, nowMs: number): string {
  return batchId ? `${base}?claimed=${encodeURIComponent(batchId)}&at=${nowMs}` : base;
}

/** The report page URL for a panel, carrying its Undo batch when it has one. */
export function claimReportHref(
  panel: { visitId: string; groupId: string },
  batchId: string | undefined,
  nowMs: number,
): string {
  return withClaimQuery(`/staff/queue/consolidated/${panel.visitId}/${panel.groupId}`, batchId, nowMs);
}

/** The bench page URL for a single test, carrying its Undo batch when it has one. */
export function claimBenchHref(testRequestId: string, batchId: string | undefined, nowMs: number): string {
  return withClaimQuery(`/staff/queue/${testRequestId}`, batchId, nowMs);
}

/** Whether a claim done at `doneAt` is still inside the 10-minute Undo window (the server re-proves it). */
export function claimUndoOpen(doneAt: number, nowMs: number): boolean {
  return nowMs - doneAt <= UNDO_WINDOW_MS;
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
