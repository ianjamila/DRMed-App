import { describe, expect, it } from "vitest";
import {
  BULK_TARGET,
  bulkActionPlan,
  bulkAppointmentsMessage,
  conflictingGroupKeys,
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

describe("bulkActionPlan skippedInactiveKeys", () => {
  it("lists the inactive bookings each patient-bound button leaves out", () => {
    const plan = bulkActionPlan(
      [
        { key: "a", status: "confirmed", patientActive: true },
        { key: "d", status: "confirmed", patientActive: false },
      ],
      false,
    );
    expect(plan.arrive.skippedInactiveKeys).toEqual(["d"]);
    expect(plan.cancel.skippedInactiveKeys).toEqual([]);
  });
});

describe("conflictingGroupKeys", () => {
  it("is not conflicting when the same key repeats with the same status and same ids", () => {
    const groups = [
      { key: "k1", status: "pending_callback", ids: ["a1"] },
      { key: "k1", status: "pending_callback", ids: ["a1"] },
    ];
    expect(conflictingGroupKeys(groups)).toEqual(new Set());
  });

  it("flags a key that repeats with a different status", () => {
    const groups = [
      { key: "k1", status: "pending_callback", ids: ["a1"] },
      { key: "k1", status: "confirmed", ids: ["a1"] },
    ];
    expect(conflictingGroupKeys(groups)).toEqual(new Set(["k1"]));
  });

  it("flags a key that repeats with a different id set (order-insensitive on the matching set)", () => {
    const groups = [
      { key: "k1", status: "confirmed", ids: ["a1", "a2"] },
      { key: "k1", status: "confirmed", ids: ["a1"] },
    ];
    expect(conflictingGroupKeys(groups)).toEqual(new Set(["k1"]));
  });

  it("is not conflicting when the id set is the same but reordered", () => {
    const groups = [
      { key: "k1", status: "confirmed", ids: ["a1", "a2"] },
      { key: "k1", status: "confirmed", ids: ["a2", "a1"] },
    ];
    expect(conflictingGroupKeys(groups)).toEqual(new Set());
  });

  it("returns an empty set when every key is unique", () => {
    const groups = [
      { key: "k1", status: "confirmed", ids: ["a1"] },
      { key: "k2", status: "pending_callback", ids: ["b1"] },
    ];
    expect(conflictingGroupKeys(groups)).toEqual(new Set());
  });
});

describe("summariseOutcome / bulkAppointmentsMessage", () => {
  const groupsByKey = {
    a: { ids: ["a1", "a2"], status: "confirmed", patientActive: true },
    b: { ids: ["b1"], status: "confirmed", patientActive: true },
    c: { ids: ["c1", "c2"], status: "confirmed", patientActive: true },
  };

  it("classifies each sent booking as changed, partly changed or unchanged", () => {
    const s = summariseOutcome(["a", "b", "c"], groupsByKey, ["a1", "a2", "c1"]);
    expect(s).toEqual({ changed: ["a"], partly: ["c"], unchanged: ["b"] });
  });
});

describe("bulkAppointmentsMessage", () => {
  const groups = {
    a: { ids: ["a1"], status: "confirmed", patientActive: true, label: "Santos, Maria" },
    b: { ids: ["b1"], status: "confirmed", patientActive: true, label: "Lim, Ben" },
    c: { ids: ["c1", "c2"], status: "confirmed", patientActive: true, label: "Cruz, Ana, 2 services" },
    d: { ids: ["d1"], status: "confirmed", patientActive: false, label: "Reyes, Jo" },
  };
  it("names changed-elsewhere, partly-changed and never-sent bookings", () => {
    const msg = bulkAppointmentsMessage(
      { verb: "Marked", pastTense: "arrived" },
      { changed: ["a"], partly: ["c"], unchanged: ["b"] },
      groups,
      ["d"],
    );
    expect(msg).toBe(
      [
        "Marked 1 of 3 bookings arrived.",
        "Not changed (2):",
        "• Cruz, Ana, 2 services: partly changed — open it to check",
        "• Lim, Ben: had already changed — refresh to see its status",
        "Skipped (1):",
        "• Reyes, Jo: patient record deleted or merged",
      ].join("\n"),
    );
  });
  it("falls back to 'A booking' for a key the page no longer renders", () => {
    expect(
      bulkAppointmentsMessage({ verb: "Cancelled", pastTense: "" }, { changed: [], partly: [], unchanged: ["zz"] }, groups, []),
    ).toBe("Nothing cancelled.\nNot changed (1):\n• A booking: had already changed — refresh to see its status");
  });
});
