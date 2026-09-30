import { describe, expect, it, vi } from "vitest";
import { runUndoSteps, undoMergeSteps, UNDO_MERGE_TABLES } from "./undo-merge-steps";

describe("undoMergeSteps", () => {
  it("clears the source marker before moving any row back, and marks the ledger last", () => {
    const steps = undoMergeSteps();
    expect(steps[0]).toEqual({ kind: "clear_source_marker" });
    expect(steps.at(-1)).toEqual({ kind: "mark_ledger_undone" });
    expect(steps.filter((s) => s.kind === "move_back").map((s) => (s as { table: string }).table)).toEqual([...UNDO_MERGE_TABLES]);
  });

  it("pins UNDO_MERGE_TABLES' literal order — visits must precede critical_alerts (0184 review minor #1)", () => {
    // Not `.toEqual([...UNDO_MERGE_TABLES])` — that compares the constant to
    // itself, so sorting it (or any other reordering) would still pass. A
    // critical alert's patient_id must equal its test's patient (via the
    // test's visit, a_lifecycle_guard's (a2') check), so undo only works
    // because the visit moves back before the alert does — proved at the
    // trigger level by the 0184 smoke's s15 section.
    expect(UNDO_MERGE_TABLES).toEqual([
      "visits",
      "appointments",
      "audit_log",
      "critical_alerts",
      "patient_consents",
      "appointment_attachments",
    ]);
    expect(UNDO_MERGE_TABLES.indexOf("visits")).toBeLessThan(UNDO_MERGE_TABLES.indexOf("critical_alerts"));
  });
});

describe("runUndoSteps", () => {
  it("stops at the first failure and never marks the ledger undone", async () => {
    const run = vi.fn(async (s: { kind: string; table?: string }) =>
      s.kind === "move_back" && s.table === "appointments" ? { error: { message: "boom" } } : { error: null });
    const r = await runUndoSteps(undoMergeSteps(), run);
    expect(r).toMatchObject({ ok: false, completed: 2, failedAt: { kind: "move_back", table: "appointments" } });
    expect(run.mock.calls.map((c) => c[0].kind)).not.toContain("mark_ledger_undone");
  });
  it("runs every step when none fails", async () => {
    const r = await runUndoSteps(undoMergeSteps(), async () => ({ error: null }));
    expect(r).toEqual({ ok: true });
  });
});
