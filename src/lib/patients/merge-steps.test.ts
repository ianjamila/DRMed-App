import { describe, expect, it, vi } from "vitest";
import { MERGE_MOVE_TABLES, mergeMoveSteps, rollbackMergeMoves, runMergeMoveSteps, type MergeMoveTable } from "./merge-steps";
import { withLifecycleRetry } from "./lifecycle-retry";

type Row = { id: string };
type QueryResult = { data: Row[] | null; error: { message: string; code?: string } | null };
type RollbackResult = { error: { message: string } | null };

const okRollback = vi.fn(async (): Promise<RollbackResult> => ({ error: null }));

function emptySnapshot(): Record<MergeMoveTable, unknown[]> {
  const out = {} as Record<MergeMoveTable, unknown[]>;
  for (const t of MERGE_MOVE_TABLES) out[t] = [];
  return out;
}

describe("mergeMoveSteps", () => {
  it("pins MERGE_MOVE_TABLES' literal order — visits must precede critical_alerts", () => {
    // Not `.toEqual([...MERGE_MOVE_TABLES])` — that compares the constant to
    // itself, so a reordering would still pass. a_lifecycle_guard's (a2')
    // check requires a critical alert's patient_id to equal its test's
    // patient (via the test's visit), so the move only works because the
    // visit moves before the alert does.
    expect(MERGE_MOVE_TABLES).toEqual([
      "visits",
      "appointments",
      "audit_log",
      "critical_alerts",
      "patient_consents",
      "appointment_attachments",
    ]);
    expect(MERGE_MOVE_TABLES.indexOf("visits")).toBeLessThan(MERGE_MOVE_TABLES.indexOf("critical_alerts"));
  });

  it("builds one step per table, same order", () => {
    expect(mergeMoveSteps().map((s) => s.table)).toEqual([...MERGE_MOVE_TABLES]);
  });
});

describe("runMergeMoveSteps", () => {
  it("runs every step and returns moved rows for each when none fails; rollback never runs", async () => {
    const run = vi.fn(async (): Promise<QueryResult> => ({ data: [{ id: "r1" }], error: null }));
    const rollback = vi.fn(okRollback);
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(Object.keys(outcome.moved)).toEqual([...MERGE_MOVE_TABLES]);
    expect(outcome.moved.visits).toEqual([{ id: "r1" }]);
    expect(run).toHaveBeenCalledTimes(MERGE_MOVE_TABLES.length);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("stops at the first step that fails, reports which ones completed, and rolls those back by their exact ids", async () => {
    const run = vi.fn(async (step: { table: string }): Promise<QueryResult> =>
      step.table === "critical_alerts"
        ? { data: null, error: { message: "boom" } }
        : { data: [{ id: `${step.table}-1` }], error: null },
    );
    const rollbackCalls: { table: string; ids: unknown[] }[] = [];
    const rollback = vi.fn(async (step: { table: string }, ids: unknown[]): Promise<RollbackResult> => {
      rollbackCalls.push({ table: step.table, ids });
      return { error: null };
    });
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome).toMatchObject({
      ok: false,
      completed: MERGE_MOVE_TABLES.indexOf("critical_alerts"),
      failedAt: { table: "critical_alerts" },
      error: "boom",
      rolledBack: true,
      rollbackFailures: [],
    });
    // Steps after the failure never ran.
    expect(run).toHaveBeenCalledTimes(MERGE_MOVE_TABLES.indexOf("critical_alerts") + 1);
    if (outcome.ok) throw new Error("expected failure");
    expect(Object.keys(outcome.moved)).toEqual(["visits", "appointments", "audit_log"]);
    // Rolled back in the SAME order the moves ran (ascending) — visits,
    // appointments, audit_log — AND the failing step itself (critical_alerts)
    // is rolled back too, using ONLY the (empty) snapshot since it never
    // returned acknowledged ids — its rollback call is skipped because that
    // union is empty.
    expect(rollbackCalls).toEqual([
      { table: "visits", ids: ["visits-1"] },
      { table: "appointments", ids: ["appointments-1"] },
      { table: "audit_log", ids: ["audit_log-1"] },
    ]);
  });

  it("unknown outcome: a failing step still rolls back via its SNAPSHOT ids (the move may have committed with a lost response), after visits", async () => {
    // critical_alerts "fails" (data: null, error set) but the snapshot says
    // a row was already on source_id before the merge started — exactly the
    // shape of a commit whose HTTP response never arrived. The runner must
    // still roll it back (it has no `moved` entry to fall back on), and
    // AFTER visits, never before — a_lifecycle_guard's (a2') check would
    // refuse rolling critical_alerts back to source while its visit is still
    // on keep_id.
    const snapshot = emptySnapshot();
    snapshot.critical_alerts = ["alert-lost-response"];
    const run = vi.fn(async (step: { table: string }): Promise<QueryResult> =>
      step.table === "critical_alerts"
        ? { data: null, error: { message: "response lost" } }
        : { data: [{ id: `${step.table}-1` }], error: null },
    );
    const rollbackOrder: { table: string; ids: unknown[] }[] = [];
    const rollback = vi.fn(async (step: { table: string }, ids: unknown[]): Promise<RollbackResult> => {
      rollbackOrder.push({ table: step.table, ids });
      return { error: null };
    });
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), snapshot, run, rollback);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    // critical_alerts IS rolled back, using its snapshot id (it has no
    // acknowledged `moved` id of its own).
    const alertsCall = rollbackOrder.find((c) => c.table === "critical_alerts");
    expect(alertsCall).toEqual({ table: "critical_alerts", ids: ["alert-lost-response"] });
    // ...and strictly after visits.
    const visitsIndex = rollbackOrder.findIndex((c) => c.table === "visits");
    const alertsIndex = rollbackOrder.findIndex((c) => c.table === "critical_alerts");
    expect(visitsIndex).toBeGreaterThanOrEqual(0);
    expect(visitsIndex).toBeLessThan(alertsIndex);
    expect(outcome.rolledBack).toBe(true);
  });

  it("rolls a completed critical_alerts step back AFTER visits, never before — a_lifecycle_guard's (a2') check would fail the reverse order", async () => {
    // Failure at patient_consents (the step AFTER critical_alerts), so all
    // four tables up to and including critical_alerts completed and must be
    // rolled back. This is the case that actually exercises the ordering
    // rule: reversing completion order (critical_alerts, audit_log,
    // appointments, visits) would roll critical_alerts back to source_id
    // while its test's visit is still on keep_id, failing the a2' check for
    // the same reason described in undo-merge-steps.ts. The runner must keep
    // visits before critical_alerts, matching UNDO_MERGE_TABLES exactly.
    const run = vi.fn(async (step: { table: string }): Promise<QueryResult> =>
      step.table === "patient_consents"
        ? { data: null, error: { message: "boom" } }
        : { data: [{ id: `${step.table}-1` }], error: null },
    );
    const rollbackOrder: string[] = [];
    const rollback = vi.fn(async (step: { table: string }): Promise<RollbackResult> => {
      rollbackOrder.push(step.table);
      return { error: null };
    });
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome.ok).toBe(false);
    // patient_consents itself is the failing step with an empty snapshot and
    // no acknowledged ids, so its rollback is a genuine no-op and is
    // skipped — only the four tables that actually moved are rolled back.
    expect(rollbackOrder).toEqual(["visits", "appointments", "audit_log", "critical_alerts"]);
    expect(rollbackOrder.indexOf("visits")).toBeLessThan(rollbackOrder.indexOf("critical_alerts"));
  });

  it("a rollback failure on one table is reported (with its exact ids) and the remaining rollback steps still run", async () => {
    const run = vi.fn(async (step: { table: string }): Promise<QueryResult> =>
      step.table === "patient_consents"
        ? { data: null, error: { message: "boom" } }
        : { data: [{ id: `${step.table}-1` }], error: null },
    );
    const rollback = vi.fn(async (step: { table: string }): Promise<RollbackResult> =>
      step.table === "appointments" ? { error: { message: "rollback failed" } } : { error: null },
    );
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.rollbackFailures).toEqual([
      { table: "appointments", error: "rollback failed", ids: ["appointments-1"] },
    ]);
    // Every completed (or failing) step still got a rollback attempt despite
    // the one failure: visits, appointments, audit_log, critical_alerts,
    // patient_consents (patient_consents itself failed the move but has an
    // empty snapshot+moved union — it's skipped as a no-op, so only 4 calls).
    expect(rollback).toHaveBeenCalledTimes(4);
  });

  it("retry-then-ok: a step wrapped in withLifecycleRetry recovers from one P0072 and the merge completes; rollback never runs", async () => {
    const attempts: Record<string, number> = {};
    const run = vi.fn((step: { table: string }) =>
      withLifecycleRetry(async (): Promise<QueryResult> => {
        attempts[step.table] = (attempts[step.table] ?? 0) + 1;
        if (step.table === "appointments" && attempts[step.table] === 1) {
          return { data: null, error: { message: "lock race", code: "P0072" } };
        }
        return { data: [{ id: "ok" }], error: null };
      }),
    );
    const rollback = vi.fn(okRollback);
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome.ok).toBe(true);
    expect(attempts.appointments).toBe(2);
    expect(attempts.visits).toBe(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("a 23514 on critical_alerts is not retried, stops the merge there, and rolls back what completed (plus critical_alerts itself, a no-op with an empty snapshot)", async () => {
    const attempts: Record<string, number> = {};
    const run = vi.fn((step: { table: string }) =>
      withLifecycleRetry(async (): Promise<QueryResult> => {
        attempts[step.table] = (attempts[step.table] ?? 0) + 1;
        if (step.table === "critical_alerts") {
          return { data: null, error: { message: "check constraint violated", code: "23514" } };
        }
        return { data: [{ id: "ok" }], error: null };
      }),
    );
    const rollback = vi.fn(okRollback);
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), emptySnapshot(), run, rollback);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failedAt).toEqual({ table: "critical_alerts" });
    expect(outcome.error).toBe("check constraint violated");
    // withLifecycleRetry does not retry a non-retryable code — exactly one attempt.
    expect(attempts.critical_alerts).toBe(1);
    // patient_consents and appointment_attachments never ran.
    expect(attempts.patient_consents).toBeUndefined();
    expect(attempts.appointment_attachments).toBeUndefined();
    // The three tables that DID complete (visits, appointments, audit_log)
    // are rolled back; critical_alerts has no snapshot ids and no moved ids
    // here, so its rollback call is skipped as a no-op.
    expect(rollback).toHaveBeenCalledTimes(3);
    expect(outcome.rolledBack).toBe(true);
  });
});

describe("rollbackMergeMoves", () => {
  it("rolls back every given step, in the order given, unioning snapshot and moved ids", async () => {
    const moved = { visits: [{ id: "v-moved" }] } as Partial<Record<MergeMoveTable, { id: string }[]>>;
    const snapshot = emptySnapshot();
    snapshot.visits = ["v-moved", "v-snapshot-only"];
    snapshot.appointments = ["a-snapshot-only"];
    const calls: { table: string; ids: unknown[] }[] = [];
    const rollback = vi.fn(async (step: { table: string }, ids: unknown[]): Promise<RollbackResult> => {
      calls.push({ table: step.table, ids });
      return { error: null };
    });
    const outcome = await rollbackMergeMoves(
      [{ table: "visits" }, { table: "appointments" }],
      moved,
      snapshot,
      rollback,
    );
    expect(outcome).toEqual({ rolledBack: true, rollbackFailures: [] });
    expect(calls).toEqual([
      { table: "visits", ids: ["v-moved", "v-snapshot-only"] }, // deduped union
      { table: "appointments", ids: ["a-snapshot-only"] },
    ]);
  });

  it("skips a step with no ids in either snapshot or moved (a genuine no-op)", async () => {
    const rollback = vi.fn(okRollback);
    const outcome = await rollbackMergeMoves([{ table: "visits" }], {}, emptySnapshot(), rollback);
    expect(outcome).toEqual({ rolledBack: true, rollbackFailures: [] });
    expect(rollback).not.toHaveBeenCalled();
  });
});
