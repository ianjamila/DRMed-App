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
// The runner below stops at the FIRST move that still fails, then rolls back
// (0184 review follow-up): re-running the whole merge afterwards is no
// longer the recovery path by itself — a re-run is idempotent for rows that
// never moved, but says nothing about rows that DID move and then got left
// on keep_id if a later step failed, and Undo (undoMergeSteps) only restores
// what patient_merges.moved records, which for a stopped merge is nothing
// (the ledger is never written on failure) — so without a rollback, those
// completed moves would be invisible to Undo and silently under-reverted.
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

export interface MergeRollbackFailure {
  table: MergeMoveTable;
  error: string;
  // The exact ids this rollback attempt tried to move back to source_id —
  // reported by the caller as "stranded" when the rollback itself fails, so
  // a manual fix has something precise to act on.
  ids: unknown[];
}

export type MergeMoveOutcome<Row> =
  | { ok: true; moved: Record<MergeMoveTable, Row[]> }
  | {
      ok: false;
      failedAt: MergeMoveStep;
      completed: number;
      error: string;
      moved: Partial<Record<MergeMoveTable, Row[]>>;
      // true only when every completed step was successfully rolled back
      // (both patients are exactly as they were before the merge started).
      rolledBack: boolean;
      rollbackFailures: MergeRollbackFailure[];
    };

function uniqueIds(ids: readonly unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const id of ids) seen.set(String(id), id);
  return [...seen.values()];
}

/**
 * Rolls the given steps back to source_id, in the order given (the caller
 * decides which steps and what order — see runMergeMoveSteps and
 * mergePatientsAction's post-move failure paths for the two cases). For each
 * step, the ids clawed back are `snapshot[table] ∪ moved[table]'s ids` —
 * NOT just the acknowledged `moved` ids. The snapshot (every id that was on
 * source_id BEFORE the merge started, read once per table before any move —
 * see mergePatientsAction) covers the case a move actually committed but its
 * HTTP response was lost: PostgREST then reports an error with `data: null`,
 * so the row is on keep_id even though it was never added to `moved`. The
 * union is exact and safe either way — `rollback`'s own
 * `.eq("patient_id", keepId)` predicate makes moving an id that never left
 * source_id a no-op. A rollback failure on one table does not stop the
 * rest — every step still gets an attempt, and every failure is collected
 * (with the exact ids that attempt used) so the caller can report precisely
 * what's stranded.
 */
export async function rollbackMergeMoves<Row extends { id: unknown }>(
  steps: readonly MergeMoveStep[],
  moved: Partial<Record<MergeMoveTable, Row[]>>,
  snapshot: Record<MergeMoveTable, readonly unknown[]>,
  rollback: (step: MergeMoveStep, ids: unknown[]) => Promise<{ error: { message: string } | null }>,
): Promise<{ rolledBack: boolean; rollbackFailures: MergeRollbackFailure[] }> {
  const rollbackFailures: MergeRollbackFailure[] = [];
  for (const step of steps) {
    const ids = uniqueIds([
      ...(snapshot[step.table] ?? []),
      ...(moved[step.table] ?? []).map((r) => r.id),
    ]);
    if (ids.length === 0) continue;
    const { error } = await rollback(step, ids);
    if (error) rollbackFailures.push({ table: step.table, error: error.message, ids });
  }
  return { rolledBack: rollbackFailures.length === 0, rollbackFailures };
}

/**
 * Runs `steps` in order, calling `run(step)` for each. Stops at the first
 * step whose `run` reports an error — later steps never execute. `run` is
 * expected to build a fresh query per call (a retry re-awaiting one
 * PostgREST builder with `.select()` re-appends its Prefer header and would
 * send the mutation twice — the same trap the queue unclaim fix hit) and to
 * wrap its query in `withLifecycleRetry` so a single lock-race loss
 * (P0072/40P01) doesn't fail the whole merge.
 *
 * `snapshot` must hold, for every table, the ids that were on source_id
 * BEFORE any move ran (see rollbackMergeMoves above for why — the failing
 * step's own outcome is UNKNOWN, not just "didn't happen": `run` reporting
 * an error only means the response was lost, not that the UPDATE never
 * committed).
 *
 * On failure, every step from the first one up to and including the
 * failing step is rolled back — in the SAME order they were attempted
 * (ascending — visits, then appointments, ..., then critical_alerts if it
 * got that far), NOT reversed: a_lifecycle_guard's (a2') check re-validates
 * a critical alert's patient_id against its test's CURRENT visit patient_id
 * on every write, so moving critical_alerts back to source before its visit
 * is already back would fail that same check for the opposite reason the
 * forward move can — exactly the invariant UNDO_MERGE_TABLES documents and
 * never reverses either.
 */
export async function runMergeMoveSteps<Row extends { id: unknown }>(
  steps: readonly MergeMoveStep[],
  snapshot: Record<MergeMoveTable, readonly unknown[]>,
  run: (step: MergeMoveStep) => Promise<{ data: Row[] | null; error: { message: string } | null }>,
  rollback: (step: MergeMoveStep, ids: unknown[]) => Promise<{ error: { message: string } | null }>,
): Promise<MergeMoveOutcome<Row>> {
  const moved = {} as Record<MergeMoveTable, Row[]>;
  const completedSteps: MergeMoveStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const { data, error } = await run(step);
    if (error) {
      const { rolledBack, rollbackFailures } = await rollbackMergeMoves(
        [...completedSteps, step],
        moved,
        snapshot,
        rollback,
      );
      return {
        ok: false,
        failedAt: step,
        completed: i,
        error: error.message,
        moved,
        rolledBack,
        rollbackFailures,
      };
    }
    moved[step.table] = data ?? [];
    completedSteps.push(step);
  }
  return { ok: true, moved };
}
