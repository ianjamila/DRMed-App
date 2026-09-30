import { describe, expect, it } from "vitest";
import {
  planReportRelease,
  reportReleaseBlock,
  REPORT_REFUSAL,
  type ReportMember,
} from "./report-release-scope";

const m = (id: string, over: Partial<ReportMember> = {}): ReportMember => ({
  testRequestId: id, resultId: "r1", visitId: "v1", isPackageHeader: false, section: "chemistry",
  status: "ready_for_release", deleted: false, isDoctorLine: false, ...over,
});

describe("planReportRelease", () => {
  it("passes a plain row with no shared report through", () => {
    expect(planReportRelease({ selectedIds: ["x"], members: [], visitId: "v1", allowedSections: ["chemistry"] }))
      .toEqual({ releaseIds: ["x"], alsoIds: [], rejected: [], reportOf: {} });
  });
  it("a plain selection with no report has no pulled-in ids", () => {
    const r = planReportRelease({ selectedIds: ["x", "y"], members: [m("x", { resultId: "rx" }), m("y", { resultId: "ry" })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.releaseIds.sort()).toEqual(["x", "y"]);
    expect(r.alsoIds).toEqual([]);
    expect(r.reportOf).toEqual({});
  });
  it("pulls in every ready member of a touched report", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b"), m("c", { status: "released" })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.releaseIds.sort()).toEqual(["a", "b"]);
    expect(r.alsoIds).toEqual(["b"]);
    expect(r.reportOf).toEqual({ a: "r1", b: "r1", c: "r1" });
  });
  it("refuses a mixed report with a member awaiting sign-off", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b", { status: "result_uploaded" })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.releaseIds).toEqual([]);
    expect(r.rejected).toEqual([{ resultId: "r1", selectedIds: ["a"], reason: REPORT_REFUSAL.notFinished(1) }]);
  });
  it("with two combined reports, only the refused (mixed) one is dropped — the complete one is released whole", () => {
    const r = planReportRelease({
      selectedIds: ["a", "c"],
      members: [
        m("a", { resultId: "r1" }), m("b", { resultId: "r1", status: "result_uploaded" }),
        m("c", { resultId: "r2" }), m("d", { resultId: "r2" }),
      ],
      visitId: "v1", allowedSections: ["chemistry"],
    });
    expect(r.releaseIds.sort()).toEqual(["c", "d"]);
    expect(r.alsoIds).toEqual(["d"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ resultId: "r1", selectedIds: ["a"] });
  });
  it("refuses a report with a deleted, unreleased member", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b", { deleted: true })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.rejected[0].reason).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("refuses a report reaching outside the caller's sections, keeping other rows", () => {
    const r = planReportRelease({
      selectedIds: ["a", "x"],
      members: [m("a"), m("b", { section: "imaging_xray" })],
      visitId: "v1", allowedSections: ["chemistry"],
    });
    expect(r.releaseIds).toEqual(["x"]);
    expect(r.rejected[0].reason).toBe(REPORT_REFUSAL.outside_sections);
  });
  it("refuses a report that carries a doctor line", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b", { isDoctorLine: true })], visitId: "v1", allowedSections: null });
    expect(r.rejected[0].reason).toBe(REPORT_REFUSAL.doctorMember);
    expect(r.releaseIds).toEqual([]);
  });
});

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
