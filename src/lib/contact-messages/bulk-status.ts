// Website Messages bulk bar (spec 2026-09-25 §7) — the pure half: which rows
// each button may send, how the server groups its guarded writes, the
// result shape, and how an Undo plans its reverse writes from the audit rows
// the bulk call wrote. Server code lives in messages/actions.ts; this module
// is imported by both sides (a "use server" file may export only async
// functions, so the shared types and constants live here).
import { CONTACT_MESSAGE_STATUS_LABEL, isContactMessageStatus, type ContactMessageStatus } from "./labels";
import { STAFF_STATUS_TARGETS, canTransition, type StaffStatusTarget } from "./status-transitions";
import type { AuditRowForUndo } from "@/lib/ui/bulk-undo";

export const MESSAGE_BULK_BUTTONS: ReadonlyArray<{
  to: StaffStatusTarget;
  label: string;
  /** formatBulkOutcome's verb + tail: "Marked 3 messages replied." / "Reopened 2 messages." */
  verb: string;
  tail: string;
  variant: "success" | "outline";
}> = [
  { to: "replied", label: "Mark replied", verb: "Marked", tail: "replied", variant: "success" },
  { to: "closed", label: "Mark closed", verb: "Marked", tail: "closed", variant: "outline" },
  { to: "new", label: "Reopen", verb: "Reopened", tail: "", variant: "outline" },
];

export function bulkMessagePlan(
  selected: ReadonlyArray<{ key: string; status: string }>,
): Record<StaffStatusTarget, string[]> {
  const plan: Record<StaffStatusTarget, string[]> = { new: [], replied: [], closed: [] };
  for (const s of selected) {
    for (const to of STAFF_STATUS_TARGETS) if (canTransition(s.status, to)) plan[to].push(s.key);
  }
  return plan;
}

export type BulkMessageResult =
  | { ok: true; changedIds: string[]; skipped: Array<{ id: string; reason: string }>; batchId?: string }
  | { ok: false; error: string };

export const MESSAGE_CHANGED_REASON = "changed since you selected it — refresh to see its status";
export const MESSAGE_GONE_REASON = "no longer exists";
export const MESSAGE_WRITE_FAILED_REASON = "could not be updated just now — try again";

const labelOf = (s: string) => (isContactMessageStatus(s) ? CONTACT_MESSAGE_STATUS_LABEL[s] : s);

export function notAllowedReason(from: string, to: StaffStatusTarget): string {
  return `a ${labelOf(from)} message can't be moved to ${labelOf(to)}`;
}

export interface MessageWriteRow {
  id: string;
  from: ContactMessageStatus;
  handled_by: string | null;
  handled_at: string | null;
}

/** One guarded UPDATE per exact (status, handled_by, handled_at) the server read. First-seen order. */
export function groupMessagesForWrite(
  rows: readonly MessageWriteRow[],
): Array<{ from: ContactMessageStatus; handledBy: string | null; handledAt: string | null; ids: string[] }> {
  const byKey = new Map<string, { from: ContactMessageStatus; handledBy: string | null; handledAt: string | null; ids: string[] }>();
  for (const r of rows) {
    const key = JSON.stringify([r.from, r.handled_by, r.handled_at]);
    const g = byKey.get(key) ?? { from: r.from, handledBy: r.handled_by, handledAt: r.handled_at, ids: [] };
    g.ids.push(r.id);
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

export interface MessageUndoEntry {
  id: string;
  /** The status the bulk call moved the message TO (the Undo write's predicate). */
  current: StaffStatusTarget;
  /** The status it had before (any stored status — booked included). */
  restoreTo: ContactMessageStatus;
  previousHandledBy: string | null;
  previousHandledAt: string | null;
  /** The exact handled_at the bulk call stamped (the Undo write's predicate). */
  stamp: string;
}

const nullableString = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

export function planMessageUndo(rows: readonly AuditRowForUndo[]): MessageUndoEntry[] {
  const out: MessageUndoEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id) || row.action !== "contact_message.status_changed") continue;
    const m = row.metadata ?? {};
    const from = m.from;
    const to = m.to;
    const stamp = m.handled_at;
    if (!("previous_handled_by" in m) || !("previous_handled_at" in m)) continue;
    const previousHandledBy = nullableString(m.previous_handled_by);
    const previousHandledAt = nullableString(m.previous_handled_at);
    if (previousHandledBy === undefined || previousHandledAt === undefined) continue;
    if (typeof stamp !== "string" || stamp.length === 0) continue;
    if (typeof from !== "string" || !isContactMessageStatus(from)) continue;
    if (typeof to !== "string" || !(STAFF_STATUS_TARGETS as readonly string[]).includes(to) || to === from) continue;
    seen.add(id);
    out.push({ id, current: to as StaffStatusTarget, restoreTo: from, previousHandledBy, previousHandledAt, stamp });
  }
  return out;
}

export function bucketMessageUndo(
  entries: readonly MessageUndoEntry[],
): Array<Omit<MessageUndoEntry, "id"> & { ids: string[] }> {
  const byKey = new Map<string, Omit<MessageUndoEntry, "id"> & { ids: string[] }>();
  for (const e of entries) {
    const key = JSON.stringify([e.current, e.restoreTo, e.previousHandledBy, e.previousHandledAt, e.stamp]);
    const { id, ...rest } = e;
    const b = byKey.get(key) ?? { ...rest, ids: [] };
    b.ids.push(id);
    byKey.set(key, b);
  }
  return [...byKey.values()];
}
