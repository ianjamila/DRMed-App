import { describe, expect, it, vi } from "vitest";
import { MERGE_MOVE_TABLES, mergeMoveSteps, runMergeMoveSteps } from "./merge-steps";
import { withLifecycleRetry } from "./lifecycle-retry";

type Row = { id: string };
type QueryResult = { data: Row[] | null; error: { message: string; code?: string } | null };

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
  it("runs every step and returns moved rows for each when none fails", async () => {
    const run = vi.fn(async (): Promise<QueryResult> => ({ data: [{ id: "r1" }], error: null }));
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), run);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(Object.keys(outcome.moved)).toEqual([...MERGE_MOVE_TABLES]);
    expect(outcome.moved.visits).toEqual([{ id: "r1" }]);
    expect(run).toHaveBeenCalledTimes(MERGE_MOVE_TABLES.length);
  });

  it("stops at the first step that fails and reports which ones completed", async () => {
    const run = vi.fn(async (step: { table: string }): Promise<QueryResult> =>
      step.table === "critical_alerts" ? { data: null, error: { message: "boom" } } : { data: [{ id: "x" }], error: null },
    );
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), run);
    expect(outcome).toMatchObject({
      ok: false,
      completed: MERGE_MOVE_TABLES.indexOf("critical_alerts"),
      failedAt: { table: "critical_alerts" },
      error: "boom",
    });
    // Steps after the failure never ran.
    expect(run).toHaveBeenCalledTimes(MERGE_MOVE_TABLES.indexOf("critical_alerts") + 1);
    if (outcome.ok) throw new Error("expected failure");
    expect(Object.keys(outcome.moved)).toEqual(["visits", "appointments", "audit_log"]);
  });

  it("retry-then-ok: a step wrapped in withLifecycleRetry recovers from one P0072 and the merge completes", async () => {
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
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), run);
    expect(outcome.ok).toBe(true);
    expect(attempts.appointments).toBe(2);
    expect(attempts.visits).toBe(1);
  });

  it("a 23514 on critical_alerts is not retried, and stops the merge there", async () => {
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
    const outcome = await runMergeMoveSteps(mergeMoveSteps(), run);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failedAt).toEqual({ table: "critical_alerts" });
    expect(outcome.error).toBe("check constraint violated");
    // withLifecycleRetry does not retry a non-retryable code — exactly one attempt.
    expect(attempts.critical_alerts).toBe(1);
    // patient_consents and appointment_attachments never ran.
    expect(attempts.patient_consents).toBeUndefined();
    expect(attempts.appointment_attachments).toBeUndefined();
  });
});
