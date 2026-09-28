import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  bucketAppointmentUndo,
  groupUndoSteps,
  planAppointmentUndo,
  planQueueUndo,
  sameInstant,
  undoOutcomeMessage,
  undoWindowStartIso,
} from "./bulk-undo";

describe("undo window", () => {
  it("is ten minutes", () => {
    expect(UNDO_WINDOW_MS).toBe(600_000);
    expect(undoWindowStartIso(Date.parse("2026-09-28T10:10:00Z"))).toBe("2026-09-28T10:00:00.000Z");
  });
});

describe("sameInstant", () => {
  it("matches a 'Z' suffix against the '+00:00' PostgREST normalizes it to on read-back", () => {
    expect(sameInstant("2026-09-28T08:13:40.467Z", "2026-09-28T08:13:40.467+00:00")).toBe(true);
  });
  it("matches identical strings", () => {
    expect(sameInstant("2026-09-28T08:13:40.467Z", "2026-09-28T08:13:40.467Z")).toBe(true);
  });
  it("rejects a genuinely different instant", () => {
    expect(sameInstant("2026-09-28T08:13:40.467Z", "2026-09-28T08:13:41.467Z")).toBe(false);
  });
  it("rejects null/undefined either side", () => {
    expect(sameInstant(null, "2026-09-28T08:13:40.467Z")).toBe(false);
    expect(sameInstant("2026-09-28T08:13:40.467Z", undefined)).toBe(false);
    expect(sameInstant(null, null)).toBe(false);
  });
  it("rejects an unparsable string", () => {
    expect(sameInstant("not-a-date", "2026-09-28T08:13:40.467Z")).toBe(false);
  });
});

describe("planAppointmentUndo", () => {
  const row = (id: string, action: string, previous: unknown, group?: string[]) => ({
    resource_id: id,
    action,
    metadata: { previous_status: previous, ...(group ? { group_appointment_ids: group } : {}) },
  });
  it("restores each row to the status it had before the bulk action", () => {
    expect(
      planAppointmentUndo([
        row("a", "appointment.cancelled", "arrived", ["a", "b"]),
        row("b", "appointment.cancelled", "arrived", ["a", "b"]),
        row("c", "appointment.confirmed", "pending_callback"),
        row("d", "appointment.no_show", "confirmed"),
      ]),
    ).toEqual([
      { id: "a", current: "cancelled", restoreTo: "arrived", groupIds: ["a", "b"] },
      { id: "b", current: "cancelled", restoreTo: "arrived", groupIds: ["a", "b"] },
      { id: "c", current: "confirmed", restoreTo: "pending_callback", groupIds: ["c"] },
      { id: "d", current: "no_show", restoreTo: "confirmed", groupIds: ["d"] },
    ]);
  });
  it("ignores deletes, unknown statuses, missing previous status and duplicates", () => {
    expect(
      planAppointmentUndo([
        row("a", "appointment.deleted", "confirmed"),
        row("b", "appointment.cancelled", "completed"),
        row("c", "appointment.cancelled", undefined),
        row("d", "appointment.cancelled", "cancelled"),
        row("e", "appointment.no_show", "confirmed"),
        row("e", "appointment.no_show", "confirmed"),
      ]).map((e) => e.id),
    ).toEqual(["e"]);
  });
  it("buckets one write per (current, restoreTo)", () => {
    const buckets = bucketAppointmentUndo(
      planAppointmentUndo([
        row("a", "appointment.cancelled", "arrived"),
        row("b", "appointment.cancelled", "confirmed"),
        row("c", "appointment.cancelled", "arrived"),
      ]),
    );
    expect(buckets).toEqual([
      { current: "cancelled", restoreTo: "arrived", ids: ["a", "c"] },
      { current: "cancelled", restoreTo: "confirmed", ids: ["b"] },
    ]);
  });
});

describe("planQueueUndo", () => {
  const P = "panel:v:g";
  it("maps claim → unclaim, unclaim → reclaim, delete → restore", () => {
    expect(
      planQueueUndo([
        {
          resource_id: "t1",
          action: "test_request.claimed",
          metadata: { visit_id: "v1", started_at: "2026-09-28T00:30:00Z" },
        },
        {
          resource_id: "t2",
          action: "test_request.unclaimed",
          metadata: { visit_id: "v1", previous_assignee: "u2", previous_started_at: "2026-09-28T01:00:00Z", panel_key: P },
        },
        {
          resource_id: "t3",
          action: "test_request.deleted",
          metadata: { visit_id: "v3", deleted_at: "2026-09-28T02:00:00Z" },
        },
      ]),
    ).toEqual([
      { kind: "unclaim", id: "t1", visitId: "v1", panelKey: null, startedAt: "2026-09-28T00:30:00Z" },
      { kind: "reclaim", id: "t2", visitId: "v1", holder: "u2", startedAt: "2026-09-28T01:00:00Z", panelKey: P },
      { kind: "restore", id: "t3", visitId: "v3", panelKey: null, deletedAt: "2026-09-28T02:00:00Z" },
    ]);
  });
  it("carries null startedAt/deletedAt when the audit row predates the fix", () => {
    expect(
      planQueueUndo([
        { resource_id: "t1", action: "test_request.claimed", metadata: { visit_id: "v1" } },
        { resource_id: "t3", action: "test_request.deleted", metadata: { visit_id: "v3" } },
      ]),
    ).toEqual([
      { kind: "unclaim", id: "t1", visitId: "v1", panelKey: null, startedAt: null },
      { kind: "restore", id: "t3", visitId: "v3", panelKey: null, deletedAt: null },
    ]);
  });
  it("skips rows it cannot reverse", () => {
    expect(
      planQueueUndo([
        { resource_id: "t1", action: "test_request.unclaimed", metadata: { visit_id: "v1" } },
        { resource_id: "t2", action: "test_request.deleted", metadata: {} },
        { resource_id: null, action: "test_request.claimed", metadata: {} },
        { resource_id: "t4", action: "test_request.restored", metadata: { visit_id: "v" } },
      ]),
    ).toEqual([]);
  });
  it("groups a panel's members under its key, singles alone", () => {
    const steps = planQueueUndo([
      { resource_id: "t1", action: "test_request.claimed", metadata: { visit_id: "v", panel_key: P } },
      { resource_id: "t2", action: "test_request.claimed", metadata: { visit_id: "v", panel_key: P } },
      { resource_id: "t3", action: "test_request.claimed", metadata: { visit_id: "v" } },
    ]);
    expect(groupUndoSteps(steps).map((g) => [g.key, g.steps.map((s) => s.id)])).toEqual([
      [P, ["t1", "t2"]],
      ["t3", ["t3"]],
    ]);
  });
});

describe("undoOutcomeMessage", () => {
  it("says what came back and names what did not", () => {
    expect(
      undoOutcomeMessage(
        { one: "booking", many: "bookings" },
        { restored: 2, notRestored: [{ label: "Santos, Maria", reason: "changed again since — refresh to see its status" }] },
      ),
    ).toBe(
      "Undone — 2 bookings are back to what they were.\nNot undone (1):\n• Santos, Maria: changed again since — refresh to see its status",
    );
  });
  it("nothing came back", () => {
    expect(undoOutcomeMessage({ one: "test", many: "tests" }, { restored: 0, notRestored: [] })).toBe("Nothing was undone.");
  });
});
