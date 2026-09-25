import { describe, expect, it } from "vitest";
import {
  BULK_TARGET,
  bulkActionPlan,
  outcomeMessage,
  summariseOutcome,
  type BulkGroup,
} from "./bulk-eligibility";

const g = (key: string, status: string, patientActive = true): BulkGroup => ({ key, status, patientActive });

describe("bulkActionPlan", () => {
  const groups = [
    g("c1", "confirmed"),
    g("c2", "confirmed", false),
    g("a1", "arrived"),
    g("n1", "no_show"),
    g("x1", "cancelled"),
    g("p1", "pending_callback"),
    g("p2", "pending_callback", false),
    g("d1", "completed"),
  ];

  it("maps every status to the buttons ALLOWED_FROM permits", () => {
    const plan = bulkActionPlan(groups, true);
    expect(plan.arrive.keys).toEqual(["c1"]);
    expect(plan.noShow.keys).toEqual(["c1", "c2"]);
    expect(plan.cancel.keys).toEqual(["c1", "c2", "a1", "p1", "p2"]);
    expect(plan.confirm.keys).toEqual(["p1"]);
    expect(plan.revert.keys).toEqual(["a1", "n1", "x1"]);
    expect(plan.delete.keys).toEqual(["c1", "c2", "a1", "n1", "x1", "p1", "p2"]);
  });

  it("counts inactive-patient rows it skipped for arrive/confirm/revert only", () => {
    const plan = bulkActionPlan(groups, true);
    expect(plan.arrive.skippedInactive).toBe(1);
    expect(plan.confirm.skippedInactive).toBe(1);
    expect(plan.revert.skippedInactive).toBe(0);
    expect(plan.cancel.skippedInactive).toBe(0);
    expect(plan.noShow.skippedInactive).toBe(0);
  });

  it("never offers delete to non-admins and never touches completed", () => {
    const plan = bulkActionPlan(groups, false);
    expect(plan.delete.keys).toEqual([]);
    for (const entry of Object.values(plan)) expect(entry.keys).not.toContain("d1");
  });

  it("targets the server transition each button means", () => {
    expect(BULK_TARGET).toEqual({
      arrive: "arrived",
      noShow: "no_show",
      cancel: "cancelled",
      confirm: "confirmed",
      revert: "confirmed",
    });
  });
});

describe("summariseOutcome / outcomeMessage", () => {
  const groupsByKey = {
    a: { ids: ["a1", "a2"], status: "confirmed", patientActive: true },
    b: { ids: ["b1"], status: "confirmed", patientActive: true },
    c: { ids: ["c1", "c2"], status: "confirmed", patientActive: true },
  };

  it("classifies each sent booking as changed, partly changed or unchanged", () => {
    const s = summariseOutcome(["a", "b", "c"], groupsByKey, ["a1", "a2", "c1"]);
    expect(s).toEqual({ changed: ["a"], partly: ["c"], unchanged: ["b"] });
  });

  it("says nothing extra when everything changed", () => {
    expect(outcomeMessage("Marked", "arrived", { changed: ["a", "b"], partly: [], unchanged: [] })).toBeNull();
  });

  it("explains partial results in bookings", () => {
    expect(
      outcomeMessage("Marked", "arrived", { changed: ["a"], partly: ["c"], unchanged: ["b"] }),
    ).toBe(
      "Marked 1 of 3 bookings arrived. 1 partly changed — open it to check. 1 had already changed.",
    );
  });

  it("omits the past tense cleanly instead of leaving a space before the period", () => {
    expect(
      outcomeMessage("Confirmed", "", { changed: ["a"], partly: [], unchanged: ["b"] }),
    ).toBe("Confirmed 1 of 2 bookings. 1 had already changed.");
  });
});
