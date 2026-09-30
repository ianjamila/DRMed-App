// Filters for the Audit Log page's bulk-action views (bulk-select follow-ups
// item 8). Both strings go straight into a PostgREST `.or()`, so a batch id
// is accepted only as a bare uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BULK_AUDIT_OR =
  "metadata->bulk_batch_size.gt.1,metadata->bulk_booking_count.gt.1,metadata->>bulk_batch_id.not.is.null";

export function parseBatchParam(v: string | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

export function batchAuditOr(batchId: string): string {
  return `metadata->>bulk_batch_id.eq.${batchId},metadata->>undo_of_batch.eq.${batchId}`;
}

// An Undo row carries its OWN new bulk_batch_id plus undo_of_batch pointing
// at the action it reversed. Preferring undo_of_batch means clicking "Whole
// batch" on either row opens the same view — the original action AND its
// Undo — instead of the Undo row alone excluding the action it reversed.
export function batchIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const undoOf = m.undo_of_batch;
  if (typeof undoOf === "string" && UUID_RE.test(undoOf)) return undoOf;
  const v = m.bulk_batch_id;
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}
