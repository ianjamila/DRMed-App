import { describe, expect, it } from "vitest";
import {
  expandUndoReleaseScope,
  groupIdsByExpectedReleasedAt,
  reportsToRefuse,
  undoUpdateIds,
  type UndoScopeMemberRow,
} from "./undo-release-scope";

const VISIT = "visit-1";

function member(overrides: Partial<UndoScopeMemberRow> = {}): UndoScopeMemberRow {
  return {
    testRequestId: "t1",
    resultId: "r1",
    visitId: VISIT,
    isPackageHeader: false,
    section: "chemistry",
    ...overrides,
  };
}

describe("expandUndoReleaseScope", () => {
  it("leaves a single test untouched when it links to no combined report", () => {
    // No members at all — as when the selected id has no result link (e.g. a
    // doctor line) or its result has exactly one member and the caller never
    // fetched a group for it.
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got).toEqual({
      ok: true,
      expandedIds: ["t1"],
      reportResultIdByTestRequestId: new Map(),
    });
  });

  it("a result linked to exactly one test is not a combined report — no expansion", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [member({ testRequestId: "t1", resultId: "r1" })],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got).toEqual({
      ok: true,
      expandedIds: ["t1"],
      reportResultIdByTestRequestId: new Map(),
    });
  });

  it("one member selected expands to all members", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1" }),
        member({ testRequestId: "t2" }),
        member({ testRequestId: "t3" }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(new Set(got.expandedIds)).toEqual(new Set(["t1", "t2", "t3"]));
    expect(got.reportResultIdByTestRequestId.get("t1")).toBe("r1");
    expect(got.reportResultIdByTestRequestId.get("t2")).toBe("r1");
    expect(got.reportResultIdByTestRequestId.get("t3")).toBe("r1");
  });

  it("a partially released report expands to the whole report regardless of member status", () => {
    // Status is not part of this helper's input at all — the caller's later
    // status-filtered UPDATE is what decides which members actually revert.
    // This fixture proves the expansion itself does not filter by it.
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"], // the only member currently 'released'
      members: [
        member({ testRequestId: "t1" }), // released
        member({ testRequestId: "t2" }), // still ready_for_release, say
        member({ testRequestId: "t3" }), // still result_uploaded, say
      ],
      visitId: VISIT,
      allowedSections: ["chemistry"],
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(new Set(got.expandedIds)).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("expands two different reports the selection touches, deduplicated", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1", "t4"],
      members: [
        member({ testRequestId: "t1", resultId: "r1" }),
        member({ testRequestId: "t2", resultId: "r1" }),
        member({ testRequestId: "t4", resultId: "r2" }),
        member({ testRequestId: "t5", resultId: "r2" }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(new Set(got.expandedIds)).toEqual(new Set(["t1", "t2", "t4", "t5"]));
  });

  it("rejects the whole request when a member sits outside the caller's sections", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1", section: "chemistry" }),
        member({ testRequestId: "t2", section: "imaging_xray" }),
      ],
      visitId: VISIT,
      allowedSections: ["chemistry"], // medtech — no xray
    });
    expect(got).toMatchObject({ ok: false, reason: "outside_sections", resultId: "r1" });
  });

  it("[] allowed sections (reception) rejects any member with a real section", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1" }),
        member({ testRequestId: "t2" }),
      ],
      visitId: VISIT,
      allowedSections: [],
    });
    expect(got).toMatchObject({ ok: false, reason: "outside_sections" });
  });

  it("rejects the whole request when a member is a package header", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1" }),
        member({ testRequestId: "t2", isPackageHeader: true }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got).toMatchObject({ ok: false, reason: "package_header", resultId: "r1" });
  });

  it("rejects the whole request when a member sits on another visit", () => {
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1", visitId: VISIT }),
        member({ testRequestId: "t2", visitId: "visit-2" }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got).toMatchObject({ ok: false, reason: "other_visit", resultId: "r1" });
  });

  it("ignores a fetched group the selection never touched", () => {
    // Defensive: if the caller ever hands over an untouched group's rows,
    // this function must not expand into it or validate it.
    const got = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1", resultId: "r1" }),
        member({ testRequestId: "t2", resultId: "r1" }),
        // Untouched group with a bad member — must not cause a rejection.
        member({ testRequestId: "t9", resultId: "r9", isPackageHeader: true }),
        member({ testRequestId: "t10", resultId: "r9" }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(new Set(got.expandedIds)).toEqual(new Set(["t1", "t2"]));
  });
});

describe("undoUpdateIds — whole-report undo racing a release", () => {
  it("targets a member released AFTER the candidate read, so the report never splits", () => {
    // Report r1 = t1 + t2. The candidate read (status = released) saw only t1;
    // t2 was released a moment later. The expansion still knows t2 is a member.
    const expansion = expandUndoReleaseScope({
      selectedIds: ["t1"],
      members: [
        member({ testRequestId: "t1", resultId: "r1" }),
        member({ testRequestId: "t2", resultId: "r1" }),
      ],
      visitId: VISIT,
      allowedSections: null,
    });
    if (!expansion.ok) throw new Error("unreachable");
    const scopedCandidates = ["t1"]; // what the candidate read returned
    const ids = undoUpdateIds(scopedCandidates, expansion.reportResultIdByTestRequestId.keys());
    expect(new Set(ids)).toEqual(new Set(["t1", "t2"]));
  });

  it("keeps a plain (single-test) selection to the candidates it read", () => {
    expect(undoUpdateIds(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("lists each id once", () => {
    expect(undoUpdateIds(["t1", "t2"], ["t2", "t1", "t3"]).sort()).toEqual(["t1", "t2", "t3"]);
  });
});

describe("reportsToRefuse — Finding 4 (P1): combined reports are all-or-nothing for a batch Undo", () => {
  it("leaves an intact report alone: every member released by this batch, none changed since", () => {
    const refused = reportsToRefuse({
      reportResultIdByTestRequestId: new Map([
        ["t1", "r1"],
        ["t2", "r1"],
      ]),
      batchReleasedIds: new Set(["t1", "t2"]),
      changedSinceIds: new Set(),
    });
    expect(refused).toEqual(new Set());
  });

  it("refuses the WHOLE report when one member was rejected as changed-since", () => {
    // t2 was flagged changed-since by loadOwnBatchRows — t1 must not come
    // back in through t2's report membership (Finding 4a).
    const refused = reportsToRefuse({
      reportResultIdByTestRequestId: new Map([
        ["t1", "r1"],
        ["t2", "r1"],
      ]),
      batchReleasedIds: new Set(["t1", "t2"]),
      changedSinceIds: new Set(["t2"]),
    });
    expect(refused).toEqual(new Set(["t1", "t2"]));
  });

  it("refuses the WHOLE report when a member was never released by this batch", () => {
    // t3 belongs to the report but has no release audit row in THIS batch —
    // an older/separate release (Finding 4b) — so t1/t2 must be refused too.
    const refused = reportsToRefuse({
      reportResultIdByTestRequestId: new Map([
        ["t1", "r1"],
        ["t2", "r1"],
        ["t3", "r1"],
      ]),
      batchReleasedIds: new Set(["t1", "t2"]), // t3 missing
      changedSinceIds: new Set(),
    });
    expect(refused).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("never touches a standalone id absent from reportResultIdByTestRequestId", () => {
    // Standalone ids keep the plain per-row rule — this function only ever
    // sees ids that expandUndoReleaseScope put in an EXPANDED report.
    const refused = reportsToRefuse({
      reportResultIdByTestRequestId: new Map(),
      batchReleasedIds: new Set(["standalone"]),
      changedSinceIds: new Set(["standalone"]),
    });
    expect(refused).toEqual(new Set());
  });

  it("refuses only the affected report, not a sibling report the batch also touched", () => {
    const refused = reportsToRefuse({
      reportResultIdByTestRequestId: new Map([
        ["t1", "r1"],
        ["t2", "r1"],
        ["t4", "r2"],
        ["t5", "r2"],
      ]),
      batchReleasedIds: new Set(["t1", "t2", "t4", "t5"]),
      changedSinceIds: new Set(["t2"]), // only r1 is bad
    });
    expect(refused).toEqual(new Set(["t1", "t2"]));
  });
});

describe("groupIdsByExpectedReleasedAt — Finding 4 (P1): predicate the write on the exact release", () => {
  it("groups ids that share the same recorded released_at into one group", () => {
    const { groups, refusedIds } = groupIdsByExpectedReleasedAt(
      ["t1", "t2", "t3"],
      new Map([
        ["t1", "2026-09-30T10:00:00.000Z"],
        ["t2", "2026-09-30T10:00:00.000Z"],
        ["t3", "2026-09-30T11:00:00.000Z"],
      ]),
    );
    expect(refusedIds).toEqual([]);
    expect(groups).toHaveLength(2);
    const byValue = new Map(groups.map((g) => [g.releasedAt, g.ids.slice().sort()]));
    expect(byValue.get("2026-09-30T10:00:00.000Z")).toEqual(["t1", "t2"]);
    expect(byValue.get("2026-09-30T11:00:00.000Z")).toEqual(["t3"]);
  });

  it("groups a 'Z' value and its PostgREST '+00:00' spelling together (sameInstant)", () => {
    // Only the map's values are ever compared with sameInstant here — this
    // fixture models a value read back in the "+00:00" shape landing in the
    // same map as one still in the "Z" shape a JS Date wrote.
    const { groups } = groupIdsByExpectedReleasedAt(
      ["t1", "t2"],
      new Map([
        ["t1", "2026-09-30T10:00:00.000Z"],
        ["t2", "2026-09-30T10:00:00.000+00:00"],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ids.slice().sort()).toEqual(["t1", "t2"]);
  });

  it("refuses ids with no recorded released_at, excluding them from every group", () => {
    const { groups, refusedIds } = groupIdsByExpectedReleasedAt(
      ["t1", "t2"],
      new Map([["t1", "2026-09-30T10:00:00.000Z"]]), // t2 missing
    );
    expect(refusedIds).toEqual(["t2"]);
    expect(groups).toEqual([{ releasedAt: "2026-09-30T10:00:00.000Z", ids: ["t1"] }]);
  });
});
