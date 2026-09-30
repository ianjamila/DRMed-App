import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  bucketAppointmentUndo,
  groupUndoSteps,
  holderByMember,
  planAppointmentUndo,
  planHistoricHmoUndo,
  planQueueUndo,
  restoredTestCountOf,
  sameInstant,
  unclaimStepStillHeld,
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

// The per-member audit rows a panel bulk write leaves (Task 3): one row per
// member, all sharing panel_key + bulk_batch_id.
describe("planQueueUndo over a panel bulk write's per-member rows", () => {
  const P = "panel:v1:g1";
  const B = "batch-1";
  it("three claimed members with one panel_key become ONE group of three unclaim steps carrying their started_at", () => {
    const claimed = (id: string, startedAt: string | null) => ({
      resource_id: id,
      action: "test_request.claimed",
      metadata: {
        visit_id: "v1",
        started_at: startedAt,
        panel_key: P,
        bulk_batch_id: B,
        bulk_batch_size: 3,
        grouped: true,
        report_group_id: "g1",
      },
    });
    const groups = groupUndoSteps(
      planQueueUndo([
        claimed("t1", "2026-09-30T01:00:00.000Z"),
        claimed("t2", "2026-09-30T01:00:00.000Z"),
        claimed("t3", "2026-09-30T01:00:00.000Z"),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(P);
    expect(groups[0]!.steps).toEqual(
      ["t1", "t2", "t3"].map((id) => ({
        kind: "unclaim",
        id,
        visitId: "v1",
        panelKey: P,
        startedAt: "2026-09-30T01:00:00.000Z",
      })),
    );
  });

  it("three unclaimed members with TWO different previous_assignee values become one group of three reclaim steps, each with its own holder", () => {
    const unclaimed = (id: string, holder: string) => ({
      resource_id: id,
      action: "test_request.unclaimed",
      metadata: {
        visit_id: "v1",
        previous_assignee: holder,
        previous_started_at: "2026-09-30T00:50:00.000Z",
        reason: "x",
        self_service: false,
        grouped: true,
        panel_key: P,
        bulk_batch_id: B,
        bulk_batch_size: 3,
      },
    });
    const groups = groupUndoSteps(planQueueUndo([unclaimed("t1", "uA"), unclaimed("t2", "uA"), unclaimed("t3", "uB")]));
    expect(groups).toHaveLength(1);
    const steps = groups[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["reclaim", "reclaim", "reclaim"]);
    const holders = holderByMember(steps.filter((s): s is Extract<typeof s, { kind: "reclaim" }> => s.kind === "reclaim"));
    expect(Object.fromEntries(holders)).toEqual({ t1: "uA", t2: "uA", t3: "uB" });
  });

  it("an outcome_unverified claim row (started_at null) plans an unclaim step with startedAt null", () => {
    const [step] = planQueueUndo([
      {
        resource_id: "t1",
        action: "test_request.claimed",
        metadata: { visit_id: "v1", started_at: null, panel_key: P, bulk_batch_id: B, grouped: true, outcome_unverified: true },
      },
    ]);
    expect(step).toEqual({ kind: "unclaim", id: "t1", visitId: "v1", panelKey: P, startedAt: null });
  });
});

describe("unclaimStepStillHeld", () => {
  const T = "2026-09-30T01:00:00.000Z";
  const row = (over: Partial<Parameters<typeof unclaimStepStillHeld>[0]> = {}) => ({
    status: "in_progress",
    assigned_to: "me",
    started_at: "2026-09-30T01:00:00.000+00:00",
    deleted_at: null,
    visits: { deleted_at: null },
    ...over,
  });
  it("accepts a member still held by the caller at the exact started_at (Z vs +00:00 read-back)", () => {
    expect(unclaimStepStillHeld(row(), { startedAt: T }, "me")).toBe(true);
  });
  it("refuses a step with a null startedAt even when the row also has a null started_at (outcome_unverified)", () => {
    expect(unclaimStepStillHeld(row(), { startedAt: null }, "me")).toBe(false);
    expect(unclaimStepStillHeld(row({ started_at: null }), { startedAt: null }, "me")).toBe(false);
  });
  it("refuses a member that moved on: another holder, another status, another started_at, deleted, or visit deleted", () => {
    expect(unclaimStepStillHeld(row({ assigned_to: "other" }), { startedAt: T }, "me")).toBe(false);
    expect(unclaimStepStillHeld(row({ status: "completed" }), { startedAt: T }, "me")).toBe(false);
    expect(unclaimStepStillHeld(row({ started_at: "2026-09-30T01:05:00.000Z" }), { startedAt: T }, "me")).toBe(false);
    expect(unclaimStepStillHeld(row({ deleted_at: T }), { startedAt: T }, "me")).toBe(false);
    expect(unclaimStepStillHeld(row({ visits: { deleted_at: T } }), { startedAt: T }, "me")).toBe(false);
  });
});

describe("holderByMember", () => {
  it("keeps each member's own holder", () => {
    expect(Object.fromEntries(holderByMember([{ id: "a", holder: "u1" }, { id: "b", holder: "u2" }]))).toEqual({
      a: "u1",
      b: "u2",
    });
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

describe("planHistoricHmoUndo", () => {
  it("plans a billed-undo from the per-claim audit row", () => {
    expect(
      planHistoricHmoUndo([
        {
          resource_id: "c1",
          action: "historic_hmo.claim_marked_billed",
          metadata: { bulk_batch_id: "b1", billed_recorded_at: "2026-09-28T08:00:00Z" },
        },
      ]),
    ).toEqual([{ kind: "billed", id: "c1", billedRecordedAt: "2026-09-28T08:00:00Z" }]);
  });

  it("plans a paid-undo carrying the JE id and every prior field", () => {
    expect(
      planHistoricHmoUndo([
        {
          resource_id: "c2",
          action: "historic_hmo.claim_marked_paid",
          metadata: {
            bulk_batch_id: "b1",
            journal_entry_id: "je1",
            paid_recorded_at: "2026-09-28T08:05:00Z",
            prior: {
              status: "overdue",
              date_paid: null,
              or_number: "OR-1",
              paid_payment_method: null,
              paid_recorded_by_staff_id: null,
              journal_entry_id: null,
            },
          },
        },
      ]),
    ).toEqual([
      {
        kind: "paid",
        id: "c2",
        journalEntryId: "je1",
        paidRecordedAt: "2026-09-28T08:05:00Z",
        priorStatus: "overdue",
        prior: {
          date_paid: null,
          or_number: "OR-1",
          paid_payment_method: null,
          paid_recorded_by_staff_id: null,
          journal_entry_id: null,
        },
      },
    ]);
  });

  it("plans a write-off undo carrying the JE id and the prior reason", () => {
    expect(
      planHistoricHmoUndo([
        {
          resource_id: "c3",
          action: "historic_hmo.claim_written_off",
          metadata: {
            bulk_batch_id: "b1",
            journal_entry_id: "je2",
            wrote_off_at: "2026-09-28T08:10:00Z",
            prior: { status: "pending", write_off_reason: null },
          },
        },
      ]),
    ).toEqual([
      {
        kind: "writeoff",
        id: "c3",
        journalEntryId: "je2",
        wroteOffAt: "2026-09-28T08:10:00Z",
        priorStatus: "pending",
        prior: { write_off_reason: null },
      },
    ]);
  });

  it("ignores the pre-existing summary row (no bulk_batch_id / distinct action), duplicates, and rows missing what it needs to restore", () => {
    expect(
      planHistoricHmoUndo([
        // The summary audit row the actions already wrote — same action name
        // as before, no per-claim distinct action, must never be planned.
        { resource_id: "c1", action: "historic_hmo.marked_billed", metadata: { claim_ids: ["c1"] } },
        // Missing billed_recorded_at.
        { resource_id: "c4", action: "historic_hmo.claim_marked_billed", metadata: {} },
        // Missing journal_entry_id.
        { resource_id: "c5", action: "historic_hmo.claim_marked_paid", metadata: { paid_recorded_at: "x", prior: { status: "pending" } } },
        // Prior status not pending/overdue (already paid before — shouldn't happen, but don't plan it).
        {
          resource_id: "c6",
          action: "historic_hmo.claim_marked_paid",
          metadata: { journal_entry_id: "je", paid_recorded_at: "x", prior: { status: "paid" } },
        },
        // Duplicate resource_id — first-seen wins.
        { resource_id: "c1", action: "historic_hmo.claim_marked_billed", metadata: { billed_recorded_at: "a" } },
        { resource_id: "c1", action: "historic_hmo.claim_marked_billed", metadata: { billed_recorded_at: "b" } },
      ]),
    ).toEqual([{ kind: "billed", id: "c1", billedRecordedAt: "a" }]);
  });
});

describe("restoredTestCountOf", () => {
  const step = (id: string) => ({ kind: "restore", id });
  const groups = [
    { key: "visit:group", steps: [step("m1"), step("m2"), step("m3")] },
    { key: "t9", steps: [step("t9")] },
    { key: "t10", steps: [step("t10")] },
  ];

  it("sums the member counts of the restored groups: a 3-test panel plus a single is 4 tests, not 2 keys", () => {
    expect(restoredTestCountOf(groups, ["visit:group", "t9"])).toBe(4);
  });

  it("counts a refused group as zero", () => {
    expect(restoredTestCountOf(groups, ["t10"])).toBe(1);
    expect(restoredTestCountOf(groups, [])).toBe(0);
  });

  it("counts a repeated key once and ignores a key that is not a group", () => {
    expect(restoredTestCountOf(groups, ["visit:group", "visit:group", "nope"])).toBe(3);
  });
});
