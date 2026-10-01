// src/lib/patients/merge-result.test.ts
import { describe, expect, it } from "vitest";
import {
  fieldList,
  movedSummary,
  parseMergeRpcResult,
  parseUndoRpcResult,
  undoableState,
  undoReportLines,
  type UndoReport,
} from "./merge-result";

const ZERO = { visits: 0, appointments: 0, audit_log: 0, critical_alerts: 0, patient_consents: 0, appointment_attachments: 0 };
const EMPTY_LEFT = { visits: [], appointments: [], audit_log: [], critical_alerts: [], patient_consents: [], appointment_attachments: [] };
const K = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;

describe("parseMergeRpcResult", () => {
  it("parses the function's jsonb", () => {
    const r = parseMergeRpcResult({
      merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002",
      moved: { ...ZERO, visits: 2 }, filled: ["phone"], rechained: 1,
    });
    expect(r).toEqual({
      mergeId: "m1", keepId: K, sourceId: S, keptDrmId: "DRM-0001", mergedDrmId: "DRM-0002",
      moved: { ...ZERO, visits: 2 }, filled: ["phone"], rechained: 1,
    });
  });
  it.each([null, "x", {}, { merge_id: "m1" }, { merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "a", merged_drm_id: "b", moved: { visits: "2" }, filled: [], rechained: 0 }])(
    "rejects malformed input %#",
    (bad) => expect(parseMergeRpcResult(bad)).toBeNull(),
  );
});

describe("parseUndoRpcResult", () => {
  it("parses the undo report", () => {
    const r = parseUndoRpcResult({
      merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
      resumed_interrupted_undo: false, moved_back: { ...ZERO, visits: 1 },
      left_on_keep: { ...EMPTY_LEFT, critical_alerts: ["a1"] }, kept_fields: ["phone"], reverted_fields: ["email"],
      rechained_back: 0,
    });
    expect(r?.leftOnKeep.critical_alerts).toEqual(["a1"]);
    expect(r?.keptFields).toEqual(["phone"]);
    expect(r?.movedBack.visits).toBe(1);
  });
  it("rejects a report missing left_on_keep", () => {
    expect(parseUndoRpcResult({ merge_id: "m1" })).toBeNull();
  });
  it("defaults rechained_not_restored to [] when absent, and parses it when present", () => {
    const payload = {
      merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
      resumed_interrupted_undo: false, moved_back: ZERO, left_on_keep: EMPTY_LEFT,
      kept_fields: [], reverted_fields: [], rechained_back: 1,
    };
    expect(parseUndoRpcResult(payload)?.rechainedNotRestored).toEqual([]);
    expect(parseUndoRpcResult({ ...payload, rechained_not_restored: ["c1"] })?.rechainedNotRestored).toEqual(["c1"]);
  });
});

describe("movedSummary / fieldList", () => {
  it("skips zeros and pluralises", () => {
    expect(movedSummary({ ...ZERO, visits: 2, appointments: 1 })).toBe("2 visits, 1 appointment");
    expect(movedSummary(ZERO)).toBe("nothing");
  });
  it("joins field labels in plain words", () => {
    expect(fieldList(["phone"])).toBe("phone");
    expect(fieldList(["phone", "email", "middle_name"])).toBe("phone, email and middle name");
  });
});

describe("undoReportLines", () => {
  const base: UndoReport = {
    mergeId: "m1", keepId: K, sourceId: S, keptDrmId: "DRM-0001", sourceDrmId: "DRM-0002",
    resumedInterruptedUndo: false, movedBack: { ...ZERO, visits: 2 }, leftOnKeep: EMPTY_LEFT,
    keptFields: [], revertedFields: [], rechainedBack: 0, rechainedNotRestored: [],
  };
  it("plain undo", () => {
    expect(undoReportLines(base)).toEqual(["Moved back to DRM-0002: 2 visits."]);
  });
  it("names the copied-in details it removed, beside the edited ones it kept", () => {
    expect(undoReportLines({ ...base, revertedFields: ["email", "address"], keptFields: ["phone"] })).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "Removed from DRM-0001 the details the merge had copied in: email and address.",
      "Kept on DRM-0001 because they were edited after the merge: phone.",
    ]);
  });
  it("kept fields, rows left on keep, chain", () => {
    expect(
      undoReportLines({ ...base, keptFields: ["phone"], leftOnKeep: { ...EMPTY_LEFT, visits: ["v1"] }, rechainedBack: 1 }),
    ).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "Kept on DRM-0001 because they were edited after the merge: phone.",
      "1 record stayed on DRM-0001 because it changed after the merge.",
      "1 older merged record points at DRM-0002 again.",
    ]);
  });
  it("resumed interrupted undo", () => {
    expect(undoReportLines({ ...base, resumedInterruptedUndo: true, keptFields: ["phone"] })).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "This finished an earlier undo that had stopped part-way.",
      "Not reverted — the earlier undo was interrupted, so check by hand: phone.",
    ]);
  });
  it("chain members that could not be re-pointed (singular)", () => {
    expect(undoReportLines({ ...base, rechainedNotRestored: ["c1"] })).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "1 older merged record could not be re-pointed back to DRM-0002 — it was changed after the merge; check it by hand.",
    ]);
  });
  it("chain members that could not be re-pointed (plural)", () => {
    expect(undoReportLines({ ...base, rechainedNotRestored: ["c1", "c2"] })).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "2 older merged records could not be re-pointed back to DRM-0002 — they were changed after the merge; check them by hand.",
    ]);
  });
});

describe("undoableState", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const row = (over: Partial<Parameters<typeof undoableState>[0]> = {}) => ({
    keepId: K, legacy: false, mergedAt: new Date(now - DAY).toISOString(),
    keep: { merged_into_id: null, deleted_at: null }, source: { merged_into_id: K, deleted_at: null }, ...over,
  });
  it("undoable", () => expect(undoableState(row(), now)).toEqual({ undoable: true, interrupted: false, reason: null }));
  it("exactly 30 days is past the window", () =>
    expect(undoableState(row({ mergedAt: new Date(now - 30 * DAY).toISOString() }), now).undoable).toBe(false));
  it("keep merged elsewhere", () =>
    expect(undoableState(row({ keep: { merged_into_id: "x", deleted_at: null } }), now).reason).toMatch(/undo that merge first/));
  it("keep deleted", () =>
    expect(undoableState(row({ keep: { merged_into_id: null, deleted_at: "2026-09-30" } }), now).reason).toMatch(/restore it first/));
  it("source deleted", () =>
    expect(undoableState(row({ source: { merged_into_id: null, deleted_at: "2026-09-30" } }), now).reason).toMatch(/merged-in record has since been deleted/));
  it("legacy row with an interrupted undo stays undoable", () =>
    expect(undoableState(row({ legacy: true, source: { merged_into_id: null, deleted_at: null } }), now)).toEqual({
      undoable: true, interrupted: true, reason: null,
    }));
  it("interrupted legacy row older than 30 days is undoable", () =>
    expect(
      undoableState(
        row({
          legacy: true,
          mergedAt: new Date(now - 45 * DAY).toISOString(),
          source: { merged_into_id: null, deleted_at: null },
        }),
        now,
      ),
    ).toEqual({ undoable: true, interrupted: true, reason: null }));
  it("v2 row whose source is no longer the tombstone", () =>
    expect(undoableState(row({ source: { merged_into_id: null, deleted_at: null } }), now).undoable).toBe(false));
  it("missing records", () => expect(undoableState(row({ keep: null }), now).undoable).toBe(false));
});
