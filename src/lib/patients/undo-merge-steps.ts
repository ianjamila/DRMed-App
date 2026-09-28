// The order undo-merge writes in (0184). The source's merge marker is cleared
// FIRST — the lifecycle guard refuses any row moved onto a still-merged
// (inactive) patient — then its rows move back table by table, then the kept
// record's filled-in fields are cleared, then the ledger is marked undone.
// The runner stops at the first failed step: the ledger stays NOT undone and
// the admin sees which step failed; running Undo again is safe (every step is
// idempotent — moving rows already back, or clearing a cleared marker,
// changes nothing).
export const UNDO_MERGE_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
] as const;

export type UndoStep =
  | { kind: "clear_source_marker" }
  | { kind: "move_back"; table: (typeof UNDO_MERGE_TABLES)[number] }
  | { kind: "clear_filled_fields" }
  | { kind: "mark_ledger_undone" };

export function undoMergeSteps(): UndoStep[] {
  return [
    { kind: "clear_source_marker" },
    ...UNDO_MERGE_TABLES.map((table) => ({ kind: "move_back" as const, table })),
    { kind: "clear_filled_fields" },
    { kind: "mark_ledger_undone" },
  ];
}

export async function runUndoSteps(
  steps: readonly UndoStep[],
  run: (step: UndoStep) => Promise<{ error: { message: string } | null }>,
): Promise<{ ok: true } | { ok: false; failedAt: UndoStep; completed: number; error: string }> {
  for (let i = 0; i < steps.length; i++) {
    const { error } = await run(steps[i]!);
    if (error) return { ok: false, failedAt: steps[i]!, completed: i, error: error.message };
  }
  return { ok: true };
}
