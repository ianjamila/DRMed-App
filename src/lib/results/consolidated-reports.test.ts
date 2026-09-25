import { describe, expect, it } from "vitest";
import {
  codeDuplicatesName,
  partitionConsolidatedMembers,
  reportHeadlineStatus,
  type ConsolidatedMemberRow,
} from "./consolidated-reports";

const row = (
  id: string,
  status: string,
  resultId: string | null = null,
  hasPdf = false,
): ConsolidatedMemberRow => ({ id, status, resultId, hasPdf });

describe("partitionConsolidatedMembers", () => {
  it("puts a fully released panel in one report and nothing in the form", () => {
    const p = partitionConsolidatedMembers([
      row("a", "released", "r1", true),
      row("b", "released", "r1", true),
      row("c", "released", "r1", true),
    ]);
    expect(p.encodeIds).toEqual([]);
    expect(p.reports).toEqual([{ resultId: "r1", memberIds: ["a", "b", "c"] }]);
  });

  it("treats ready_for_release (finalised, awaiting payment) as a finished report", () => {
    const p = partitionConsolidatedMembers([
      row("a", "ready_for_release", "r1", true),
      row("b", "ready_for_release", "r1", true),
    ]);
    expect(p.encodeIds).toEqual([]);
    expect(p.reports).toHaveLength(1);
  });

  it("keeps a result_uploaded member with a stored PDF out of the form", () => {
    const p = partitionConsolidatedMembers([row("a", "result_uploaded", "r1", true)]);
    expect(p.encodeIds).toEqual([]);
    expect(p.reports).toEqual([{ resultId: "r1", memberIds: ["a"] }]);
  });

  it("leaves a half-finished finalise (linked, no PDF) in the form for a retry", () => {
    const p = partitionConsolidatedMembers([row("a", "in_progress", "r1", false)]);
    expect(p.encodeIds).toEqual(["a"]);
    expect(p.reports).toEqual([]);
  });

  it("shows the form AND the report when a test was added after finalise", () => {
    const p = partitionConsolidatedMembers([
      row("a", "released", "r1", true),
      row("late", "requested"),
      row("b", "released", "r1", true),
    ]);
    expect(p.encodeIds).toEqual(["late"]);
    expect(p.reports).toEqual([{ resultId: "r1", memberIds: ["a", "b"] }]);
  });

  it("lists two reports for one visit + group separately, in first-seen order", () => {
    const p = partitionConsolidatedMembers([
      row("x", "released", "r2", true),
      row("a", "released", "r1", true),
      row("y", "ready_for_release", "r2", true),
    ]);
    expect(p.reports).toEqual([
      { resultId: "r2", memberIds: ["x", "y"] },
      { resultId: "r1", memberIds: ["a"] },
    ]);
  });

  it("drops cancelled tests from both lists", () => {
    const p = partitionConsolidatedMembers([row("a", "cancelled")]);
    expect(p).toEqual({ encodeIds: [], reports: [] });
  });
});

describe("reportHeadlineStatus", () => {
  it("is released only when every member is", () => {
    expect(reportHeadlineStatus(["released", "released"])).toBe("released");
    expect(reportHeadlineStatus(["released", "ready_for_release"])).toBe("ready_for_release");
    expect(reportHeadlineStatus(["ready_for_release", "result_uploaded"])).toBe("result_uploaded");
  });
});

describe("codeDuplicatesName", () => {
  it("matches codes that only repeat the name", () => {
    expect(codeDuplicatesName("TRIGLYCERIDES", "TRIGLYCERIDES")).toBe(true);
    expect(codeDuplicatesName("SGOT_AST", "SGOT/AST")).toBe(true);
    expect(codeDuplicatesName("HDL_LDL_VLDL", "HDL/LDL/VLDL")).toBe(true);
    expect(codeDuplicatesName("URINALYSIS", "Urinalysis")).toBe(true);
  });

  it("keeps codes that add information", () => {
    expect(codeDuplicatesName("CBC_PC", "CBC + PC")).toBe(true);
    expect(codeDuplicatesName("ECG", "12-Lead ECG")).toBe(false);
    expect(codeDuplicatesName("XRAY_CHEST_PA_LAT_ADULT", "XRAY - CHEST PA/LAT (ADULT)")).toBe(true);
    expect(codeDuplicatesName("", "")).toBe(false);
  });
});
