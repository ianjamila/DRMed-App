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

/** Result of an Undo. Ids are the keys the bar knows: appointment ids, or queue selection keys. */
export type BulkUndoResult =
  | { ok: true; restoredIds: string[]; notRestored: Array<{ id: string; reason: string }> }
  | { ok: false; error: string };

export const UNDO_EXPIRED =
  "Undo is no longer available — it lasts 10 minutes and only for your own bulk changes.";
export const UNDO_ALREADY = "This bulk change was already undone.";

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
  | { kind: "unclaim"; id: string; visitId: string | null; panelKey: string | null }
  | { kind: "reclaim"; id: string; visitId: string | null; holder: string; startedAt: string | null; panelKey: string | null }
  | { kind: "restore"; id: string; visitId: string; panelKey: string | null };

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
      step = { kind: "unclaim", id, visitId, panelKey };
    } else if (row.action === "test_request.unclaimed") {
      const holder = str(m.previous_assignee);
      if (holder) step = { kind: "reclaim", id, visitId, holder, startedAt: str(m.previous_started_at), panelKey };
    } else if (row.action === "test_request.deleted") {
      if (visitId) step = { kind: "restore", id, visitId, panelKey };
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
