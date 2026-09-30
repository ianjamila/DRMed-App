// The order the merge moves rows in (0184 review finding P1). Six FK tables
// are reassigned source→keep before the source is tombstoned. Must be the
// same table order as UNDO_MERGE_TABLES (undo-merge-steps.ts) — visits before
// critical_alerts: a_lifecycle_guard's (a2') check requires a critical
// alert's patient_id to equal its test's patient (via the test's visit), so
// if the visit hasn't moved yet the alert's move fails that check for an
// unrelated reason.
//
// Before this fix every move ran unconditionally and errors were IGNORED —
// since 0184 a move can fail with 40P01 (the merge takes a visit row lock
// before the patient's exclusive lifecycle lock, and a concurrent payment
// path can take the shared lock first), P0072 (the record moved mid-save),
// or 23514 (the critical_alerts check above). The merge would then tombstone
// the source and write the ledger anyway, using whatever ids DID come back —
// stranding the rows that didn't move on a now-inactive (merged) patient:
// unreachable, and write-blocked because a_lifecycle_guard refuses writes
// onto a merged patient. Worse, a re-run was refused ("already merged").
//
// The runner below stops at the FIRST move that still fails and reports
// which ones completed. Every move is idempotent (a repeat UPDATE matches
// zero rows for an already-moved id, since it filters on patient_id =
// source), so re-running the whole merge after a partial failure picks up
// exactly where it stopped — same "safe to re-run" contract as the undo
// runner.
export const MERGE_MOVE_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  // 0167: current_patient_id() is active-only, so a portal token for the
  // (now-merged) source patient can no longer reach these through RLS. Move
  // them the same way as the other FK tables, or they become unreachable —
  // nobody else owns them.
  "appointment_attachments",
] as const;

export type MergeMoveTable = (typeof MERGE_MOVE_TABLES)[number];

export interface MergeMoveStep {
  table: MergeMoveTable;
}

export function mergeMoveSteps(): MergeMoveStep[] {
  return MERGE_MOVE_TABLES.map((table) => ({ table }));
}

export type MergeMoveOutcome<Row> =
  | { ok: true; moved: Record<MergeMoveTable, Row[]> }
  | {
      ok: false;
      failedAt: MergeMoveStep;
      completed: number;
      error: string;
      moved: Partial<Record<MergeMoveTable, Row[]>>;
    };

/**
 * Runs `steps` in order, calling `run(step)` for each. Stops at the first
 * step whose `run` reports an error — later steps never execute — and
 * returns which steps completed (with the rows they moved) plus the failing
 * step and its error. `run` is expected to build a fresh query per call (a
 * retry re-awaiting one PostgREST builder with `.select()` re-appends its
 * Prefer header and would send the mutation twice — the same trap the queue
 * unclaim fix hit) and to wrap its query in `withLifecycleRetry` so a single
 * lock-race loss (P0072/40P01) doesn't fail the whole merge.
 */
export async function runMergeMoveSteps<Row extends { id: unknown }>(
  steps: readonly MergeMoveStep[],
  run: (step: MergeMoveStep) => Promise<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<MergeMoveOutcome<Row>> {
  const moved = {} as Record<MergeMoveTable, Row[]>;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const { data, error } = await run(step);
    if (error) {
      return { ok: false, failedAt: step, completed: i, error: error.message, moved };
    }
    moved[step.table] = data ?? [];
  }
  return { ok: true, moved };
}
