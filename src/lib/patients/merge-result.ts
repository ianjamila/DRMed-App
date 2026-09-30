// src/lib/patients/merge-result.ts
// Pure helpers around the 0196 merge functions: parse their jsonb results,
// word them for an admin, and decide whether a ledger row can be undone.
// undoableState mirrors undo_patient_merge_guarded's own refusals so the
// page can grey out Undo with the same reason — the SQL stays authoritative.
import {
  MERGE_FILL_LABELS,
  MERGE_MOVED_LABELS,
  MERGE_MOVED_TABLES,
  MERGE_UNDO_WINDOW_DAYS,
  isMergeFillField,
  type MergeMovedTable,
} from "./merge-fields";

export type MovedCounts = Record<MergeMovedTable, number>;

export interface MergeSummary {
  mergeId: string;
  keepId: string;
  sourceId: string;
  keptDrmId: string;
  mergedDrmId: string;
  moved: MovedCounts;
  filled: string[];
  rechained: number;
}

export interface UndoReport {
  mergeId: string;
  keepId: string;
  sourceId: string;
  keptDrmId: string;
  sourceDrmId: string;
  resumedInterruptedUndo: boolean;
  movedBack: MovedCounts;
  leftOnKeep: Record<MergeMovedTable, string[]>;
  keptFields: string[];
  revertedFields: string[];
  rechainedBack: number;
  rechainedNotRestored: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function strArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number") ? v.map(String) : null;
}
function counts(v: unknown): MovedCounts | null {
  if (!isObj(v)) return null;
  const out = {} as MovedCounts;
  for (const t of MERGE_MOVED_TABLES) {
    const n = v[t];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[t] = n;
  }
  return out;
}

export function parseMergeRpcResult(data: unknown): MergeSummary | null {
  if (!isObj(data)) return null;
  const mergeId = str(data.merge_id);
  const keepId = str(data.keep_id);
  const sourceId = str(data.source_id);
  const keptDrmId = str(data.kept_drm_id);
  const mergedDrmId = str(data.merged_drm_id);
  const moved = counts(data.moved);
  const filled = strArray(data.filled);
  const rechained = typeof data.rechained === "number" ? data.rechained : null;
  if (!mergeId || !keepId || !sourceId || !keptDrmId || !mergedDrmId || !moved || !filled || rechained === null) return null;
  return { mergeId, keepId, sourceId, keptDrmId, mergedDrmId, moved, filled, rechained };
}

export function parseUndoRpcResult(data: unknown): UndoReport | null {
  if (!isObj(data) || !isObj(data.left_on_keep)) return null;
  const leftOnKeep = {} as Record<MergeMovedTable, string[]>;
  for (const t of MERGE_MOVED_TABLES) {
    const ids = strArray(data.left_on_keep[t]);
    if (!ids) return null;
    leftOnKeep[t] = ids;
  }
  const mergeId = str(data.merge_id);
  const keepId = str(data.keep_id);
  const sourceId = str(data.source_id);
  const keptDrmId = str(data.kept_drm_id);
  const sourceDrmId = str(data.source_drm_id);
  const movedBack = counts(data.moved_back);
  const keptFields = strArray(data.kept_fields);
  const revertedFields = strArray(data.reverted_fields);
  const rechainedBack = typeof data.rechained_back === "number" ? data.rechained_back : null;
  // Optional: absent in an older payload (e.g. a fixture pinned before F6) — default to [].
  const rechainedNotRestored = data.rechained_not_restored === undefined ? [] : strArray(data.rechained_not_restored);
  if (!mergeId || !keepId || !sourceId || !keptDrmId || !sourceDrmId || !movedBack || !keptFields || !revertedFields
      || rechainedBack === null || rechainedNotRestored === null || typeof data.resumed_interrupted_undo !== "boolean") {
    return null;
  }
  return {
    mergeId, keepId, sourceId, keptDrmId, sourceDrmId,
    resumedInterruptedUndo: data.resumed_interrupted_undo,
    movedBack, leftOnKeep, keptFields, revertedFields, rechainedBack, rechainedNotRestored,
  };
}

export function movedSummary(moved: MovedCounts): string {
  const parts = MERGE_MOVED_TABLES.filter((t) => moved[t] > 0).map(
    (t) => `${moved[t]} ${moved[t] === 1 ? MERGE_MOVED_LABELS[t].one : MERGE_MOVED_LABELS[t].many}`,
  );
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

export function fieldList(fields: string[]): string {
  const words = fields.map((f) => (isMergeFillField(f) ? MERGE_FILL_LABELS[f] : f));
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function undoReportLines(r: UndoReport): string[] {
  const lines = [`Moved back to ${r.sourceDrmId}: ${movedSummary(r.movedBack)}.`];
  if (r.resumedInterruptedUndo) lines.push("This finished an earlier undo that had stopped part-way.");
  if (r.keptFields.length > 0) {
    lines.push(
      r.resumedInterruptedUndo
        ? `Not reverted — the earlier undo was interrupted, so check by hand: ${fieldList(r.keptFields)}.`
        : `Kept on ${r.keptDrmId} because they were edited after the merge: ${fieldList(r.keptFields)}.`,
    );
  }
  const left = MERGE_MOVED_TABLES.reduce((n, t) => n + r.leftOnKeep[t].length, 0);
  if (left > 0) {
    lines.push(
      left === 1
        ? `1 record stayed on ${r.keptDrmId} because it changed after the merge.`
        : `${left} records stayed on ${r.keptDrmId} because they changed after the merge.`,
    );
  }
  if (r.rechainedBack > 0) {
    lines.push(
      r.rechainedBack === 1
        ? `1 older merged record points at ${r.sourceDrmId} again.`
        : `${r.rechainedBack} older merged records point at ${r.sourceDrmId} again.`,
    );
  }
  if (r.rechainedNotRestored.length > 0) {
    const n = r.rechainedNotRestored.length;
    lines.push(
      n === 1
        ? `1 older merged record still points at ${r.keptDrmId} — it was changed after the merge.`
        : `${n} older merged records still point at ${r.keptDrmId} — they were changed after the merge.`,
    );
  }
  return lines;
}

interface LifecycleCols {
  merged_into_id: string | null;
  deleted_at: string | null;
}

export function undoableState(
  row: { keepId: string; legacy: boolean; mergedAt: string; keep: LifecycleCols | null; source: LifecycleCols | null },
  nowMs: number,
): { undoable: boolean; interrupted: boolean; reason: string | null } {
  const no = (reason: string) => ({ undoable: false, interrupted: false, reason });
  if (!row.keep || !row.source) return no("One of the two records could not be found.");
  // Decided BEFORE the 30-day window check (mirrors undo_patient_merge_guarded's
  // F1 fix): an interrupted legacy undo has already cleared the source's
  // marker, so it must always be completable, at any age.
  const interrupted = row.source.merged_into_id === null && row.legacy;
  if (!interrupted && nowMs - Date.parse(row.mergedAt) >= MERGE_UNDO_WINDOW_DAYS * 86_400_000) {
    return no(`Past the ${MERGE_UNDO_WINDOW_DAYS}-day undo window.`);
  }
  if (row.keep.merged_into_id) {
    return no("The kept record has since been merged into another record — undo that merge first.");
  }
  if (row.keep.deleted_at) return no("The kept record has since been deleted — restore it first.");
  if (row.source.deleted_at) return no("The merged-in record has since been deleted — restore it first.");
  if (row.source.merged_into_id === row.keepId) return { undoable: true, interrupted: false, reason: null };
  if (interrupted) return { undoable: true, interrupted: true, reason: null };
  return no("The merged-in record is no longer merged into the kept record.");
}
