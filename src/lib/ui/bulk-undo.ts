// Undo for bulk actions (owner 2026-09-28): available for 10 minutes, only to
// the staff member who ran the action, and only for rows still in the state
// the action left them. WHAT to restore is read back from the audit rows the
// action wrote (tagged with a per-call `bulk_batch_id`), never taken from the
// browser. Pure planning lives here; the writes live in the server actions.

export const UNDO_WINDOW_MINUTES = 10;
export const UNDO_WINDOW_MS = UNDO_WINDOW_MINUTES * 60_000;
/** metadata.via on every audit row an Undo writes. */
export const BULK_UNDO_VIA = "bulk_undo";

export function undoWindowStartIso(nowMs: number): string {
  return new Date(nowMs - UNDO_WINDOW_MS).toISOString();
}

/**
 * Do two ISO timestamps name the SAME instant? PostgREST normalizes a
 * `.toISOString()` "Z" suffix to "+00:00" on read-back (empirically verified
 * against the local stack), so a raw string comparison between a value this
 * app wrote (via `new Date().toISOString()`) and the same value read back
 * from a SELECT silently never matches — exactly the exact-predicate checks
 * this file's callers use to prove an Undo is reversing the SAME write it
 * made, not a coincidentally-identical later one. Always compare as instants.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
}

/** Result of an Undo. Ids are the keys the bar knows: appointment ids, or queue selection keys. */
export type BulkUndoResult =
  | { ok: true; restoredIds: string[]; notRestored: Array<{ id: string; reason: string }> }
  | { ok: false; error: string };

export const UNDO_EXPIRED =
  "Undo is no longer available — it lasts 10 minutes and only for your own bulk changes.";
export const UNDO_ALREADY = "This bulk change was already undone.";
/**
 * A row the batch touched has a NEWER audit row (any actor, any action) that
 * does not belong to this batch — someone or something else changed it since,
 * so Undo refuses it (a whole panel, for a queue panel) rather than risk
 * reversing a change it never made. Same reason used whether the guard caught
 * it up front (loadOwnBatchRows' `changedSince`) or the write's own predicate
 * simply didn't match at Undo time.
 */
export const CHANGED_SINCE_REASON = "changed again since — refresh to see its status";

export interface AuditRowForUndo {
  resource_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
}

const APPT_UNDOABLE = new Set(["arrived", "no_show", "cancelled", "confirmed"]);
const APPT_RESTORABLE = new Set(["confirmed", "arrived", "no_show", "cancelled", "pending_callback"]);

export interface AppointmentUndoEntry {
  id: string;
  current: string;
  restoreTo: string;
  groupIds: string[];
}

export function planAppointmentUndo(rows: readonly AuditRowForUndo[]): AppointmentUndoEntry[] {
  const out: AppointmentUndoEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id) || !row.action.startsWith("appointment.")) continue;
    const current = row.action.slice("appointment.".length);
    const restoreTo = row.metadata?.previous_status;
    if (!APPT_UNDOABLE.has(current)) continue;
    if (typeof restoreTo !== "string" || !APPT_RESTORABLE.has(restoreTo) || restoreTo === current) continue;
    const g = row.metadata?.group_appointment_ids;
    const groupIds = Array.isArray(g) && g.every((x) => typeof x === "string") ? (g as string[]) : [id];
    seen.add(id);
    out.push({ id, current, restoreTo, groupIds });
  }
  return out;
}

/** One write per (current, restoreTo): its predicate is `status = current`. First-seen order. */
export function bucketAppointmentUndo(
  entries: readonly AppointmentUndoEntry[],
): Array<{ current: string; restoreTo: string; ids: string[] }> {
  const byKey = new Map<string, { current: string; restoreTo: string; ids: string[] }>();
  for (const e of entries) {
    const key = `${e.current}>${e.restoreTo}`;
    const bucket = byKey.get(key) ?? { current: e.current, restoreTo: e.restoreTo, ids: [] };
    bucket.ids.push(e.id);
    byKey.set(key, bucket);
  }
  return [...byKey.values()];
}

export type QueueUndoStep =
  // startedAt: the exact value the original bulk claim wrote (metadata.started_at) —
  // the Undo's unclaim write predicates on it, so it can only ever reverse
  // THIS claim, never a same-holder reclaim that happened since (P1: undo
  // overwriting a newer change).
  | { kind: "unclaim"; id: string; visitId: string | null; panelKey: string | null; startedAt: string | null }
  | { kind: "reclaim"; id: string; visitId: string | null; holder: string; startedAt: string | null; panelKey: string | null }
  // deletedAt: the exact value the original bulk delete wrote
  // (metadata.deleted_at) — restoreTestRequestsForVisit's expectedDeletedAtOf
  // predicates on it, same reason.
  | { kind: "restore"; id: string; visitId: string; panelKey: string | null; deletedAt: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function planQueueUndo(rows: readonly AuditRowForUndo[]): QueueUndoStep[] {
  const out: QueueUndoStep[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id)) continue;
    const m = row.metadata ?? {};
    const visitId = str(m.visit_id);
    const panelKey = str(m.panel_key);
    let step: QueueUndoStep | null = null;
    if (row.action === "test_request.claimed") {
      step = { kind: "unclaim", id, visitId, panelKey, startedAt: str(m.started_at) };
    } else if (row.action === "test_request.unclaimed") {
      const holder = str(m.previous_assignee);
      if (holder) step = { kind: "reclaim", id, visitId, holder, startedAt: str(m.previous_started_at), panelKey };
    } else if (row.action === "test_request.deleted") {
      if (visitId) step = { kind: "restore", id, visitId, panelKey, deletedAt: str(m.deleted_at) };
    }
    if (!step) continue;
    seen.add(id);
    out.push(step);
  }
  return out;
}

/** A panel's members travel together (all-or-nothing); every other step alone. First-seen order. */
export function groupUndoSteps(steps: readonly QueueUndoStep[]): Array<{ key: string; steps: QueueUndoStep[] }> {
  const byKey = new Map<string, QueueUndoStep[]>();
  for (const s of steps) {
    const key = s.panelKey ?? s.id;
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  return [...byKey].map(([key, list]) => ({ key, steps: list }));
}

/**
 * The message a bulk bar shows once an Undo finishes: how many rows came
 * back, and every row that did not, named with why. Mirrors
 * `formatBulkOutcome`'s "every skipped row is named" rule, for the reverse
 * direction.
 */
export function undoOutcomeMessage(
  noun: { one: string; many: string },
  r: { restored: number; notRestored: ReadonlyArray<{ label: string; reason: string }> },
): string {
  const head =
    r.restored === 0
      ? "Nothing was undone."
      : `Undone — ${r.restored} ${r.restored === 1 ? noun.one : noun.many} ${r.restored === 1 ? "is" : "are"} back to what ${r.restored === 1 ? "it was" : "they were"}.`;
  if (r.notRestored.length === 0) return head;
  return [head, `Not undone (${r.notRestored.length}):`, ...r.notRestored.map((l) => `• ${l.label}: ${l.reason}`)].join("\n");
}
