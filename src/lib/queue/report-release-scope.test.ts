import { describe, expect, it } from "vitest";
import { panelReleaseScope, reportReleaseBlock, REPORT_REFUSAL } from "./report-release-scope";

describe("reportReleaseBlock", () => {
  const mem = (status: string, deleted = false) => ({ status, deleted });
  it("is null when every live member is ready or released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released")])).toBeNull();
  });
  it("refuses a deleted, unreleased member first", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("ready_for_release", true)])).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("counts unfinished live members", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("result_uploaded"), mem("in_progress")]))
      .toBe(REPORT_REFUSAL.notFinished(2));
  });
  it("ignores a deleted member that was released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released", true)])).toBeNull();
  });
});

describe("panelReleaseScope", () => {
  const m = (id: string, status: string, resultId: string | null) => ({ id, status, resultId });

  it("releases the finished report while a sibling report on the panel waits", () => {
    const out = panelReleaseScope([
      m("a1", "ready_for_release", "R1"),
      m("a2", "ready_for_release", "R1"),
      m("b1", "ready_for_release", "R2"),
      m("b2", "in_progress", "R2"),
    ]);
    expect(out.readyIds).toEqual(["a1", "a2"]);
    expect(out.reportBlock).toBeNull();
  });

  it("the old whole-group judgement would have blocked R1 (regression)", () => {
    const members = [m("a1", "ready_for_release", "R1"), m("b1", "in_progress", "R2")];
    // Old behaviour: one block over every linked member.
    const wholeGroup = reportReleaseBlock(members.map((x) => ({ status: x.status, deleted: false })));
    expect(wholeGroup).not.toBeNull();
    const out = panelReleaseScope(members);
    expect(out.readyIds).toEqual(["a1"]);
    expect(out.reportBlock).toBeNull();
  });

  it("returns the first report's block when every report is blocked", () => {
    const out = panelReleaseScope([
      m("a1", "ready_for_release", "R1"),
      m("a2", "in_progress", "R1"),
      m("b1", "ready_for_release", "R2"),
      m("b2", "in_progress", "R2"),
      m("b3", "in_progress", "R2"),
    ]);
    expect(out.readyIds).toEqual([]);
    expect(out.reportBlock).toBe(REPORT_REFUSAL.notFinished(1));
  });

  it("includes a ready member that has no report", () => {
    const out = panelReleaseScope([m("x", "ready_for_release", null)]);
    expect(out).toEqual({ readyIds: ["x"], reportBlock: null });
  });

  it("keeps an unlinked ready member alongside a blocked report", () => {
    const out = panelReleaseScope([
      m("x", "ready_for_release", null),
      m("a1", "ready_for_release", "R1"),
      m("a2", "in_progress", "R1"),
    ]);
    expect(out.readyIds).toEqual(["x"]);
    expect(out.reportBlock).toBeNull();
  });

  it("treats a part-released report as releasable", () => {
    const out = panelReleaseScope([m("a1", "released", "R1"), m("a2", "ready_for_release", "R1")]);
    expect(out).toEqual({ readyIds: ["a2"], reportBlock: null });
  });

  it("a fully released report contributes nothing and blocks nothing", () => {
    const out = panelReleaseScope([
      m("a1", "released", "R1"),
      m("a2", "released", "R1"),
      m("b1", "ready_for_release", "R2"),
    ]);
    expect(out).toEqual({ readyIds: ["b1"], reportBlock: null });
    expect(panelReleaseScope([m("a1", "released", "R1")])).toEqual({ readyIds: [], reportBlock: null });
  });

  it("preserves the members' original order", () => {
    const out = panelReleaseScope([
      m("c", "ready_for_release", "R2"),
      m("a", "ready_for_release", "R1"),
      m("b", "ready_for_release", null),
    ]);
    expect(out.readyIds).toEqual(["c", "a", "b"]);
  });
});
