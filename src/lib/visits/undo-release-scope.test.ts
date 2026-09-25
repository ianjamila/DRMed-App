import { describe, expect, it } from "vitest";
import {
  expandUndoReleaseScope,
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
