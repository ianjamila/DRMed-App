import { describe, expect, it } from "vitest";
import {
  deriveUndoneRelease,
  parseUndoneReleasesParams,
  summariseUndoneReleases,
  UNDONE_RELEASES_CSV_HEADER,
  undoneReleasesCsvFilename,
  undoneReleasesCsvHref,
  undoneReleasesCsvRows,
  type AuditRow,
  type TestRequestRow,
} from "./undone-releases";

const TODAY = "2026-09-08";

describe("parseUndoneReleasesParams", () => {
  it("defaults to the last 90 days and rejects non-ISO input", () => {
    expect(parseUndoneReleasesParams({}, TODAY)).toEqual({ start: "2026-06-10", end: TODAY });
    expect(parseUndoneReleasesParams({ start: "bad", end: "2026-09-01" }, TODAY)).toEqual({ start: "2026-06-10", end: "2026-09-01" });
  });
});

const staffUndo: AuditRow = {
  id: 1, created_at: "2026-09-08T02:00:00Z", actor_id: "u1", actor_type: "staff", resource_id: "t1",
  metadata: { reason: "wrong patient", viewed_count: 2 },
};
const cascade: AuditRow = {
  id: 2, created_at: "2026-09-08T02:00:01Z", actor_id: null, actor_type: "system", resource_id: "h1",
  metadata: { cascaded_from: "t1" },
};
const trById = new Map<string, TestRequestRow>([
  ["t1", { id: "t1", status: "released", released_at: "2026-09-08T03:00:00Z", visit_id: "v1", services: { name: "CBC", code: "CBC" }, visits: { visit_number: "0042", patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } } }],
  ["h1", { id: "h1", status: "ready_for_release", released_at: null, visit_id: "v1", services: [{ name: "Routine package", code: "ROUTINE" }], visits: { visit_number: "0042", patients: null } }],
]);
const staff = new Map([["u1", "Path One"]]);

describe("deriveUndoneRelease", () => {
  it("resolves a staff undo with reason, views and current status", () => {
    expect(deriveUndoneRelease(staffUndo, trById, staff)).toMatchObject({
      isCascade: false, actorName: "Path One", reason: "wrong patient", viewedCount: 2,
      serviceName: "CBC", serviceCode: "CBC", visitNumber: "0042", visitId: "v1",
      currentStatus: "released", releasedAt: "2026-09-08T03:00:00Z",
    });
  });
  it("marks a system cascade and flattens array embeds", () => {
    expect(deriveUndoneRelease(cascade, trById, staff)).toMatchObject({
      isCascade: true, actorName: null, reason: null, viewedCount: null,
      serviceName: "Routine package", currentStatus: "ready_for_release", patient: null,
    });
  });

  it("flattens array-shaped visits and patients embeds too", () => {
    const arr = new Map<string, TestRequestRow>([
      ["t9", { id: "t9", status: "released", released_at: null, visit_id: "v9", services: { name: "FBS", code: "FBS" }, visits: [{ visit_number: "0099", patients: [{ first_name: "Zed", last_name: "Yu", drm_id: "DRM-9" }] }] }],
    ]);
    const e = deriveUndoneRelease({ ...staffUndo, resource_id: "t9" }, arr, staff);
    expect(e.visitNumber).toBe("0099");
    expect(e.visitId).toBe("v9");
    expect(e.patient?.drm_id).toBe("DRM-9");
  });
});

describe("summariseUndoneReleases", () => {
  it("counts staff undos, still-unreleased, re-released and viewed-before-undo", () => {
    const entries = [staffUndo, cascade].map((r) => deriveUndoneRelease(r, trById, staff));
    expect(summariseUndoneReleases(entries)).toEqual({ staffUndos: 1, stillUnreleased: 1, reReleased: 1, viewedBeforeUndo: 1 });
  });
});

describe("undoneReleasesCsvRows", () => {
  it("mirrors the table columns", () => {
    const entries = [staffUndo, cascade].map((r) => deriveUndoneRelease(r, trById, staff));
    const out = undoneReleasesCsvRows(entries);
    expect(out[0]).toEqual([...UNDONE_RELEASES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08 10:00", "Cruz, Ana", "DRM-1", "0042", "CBC", "CBC", "Path One", "wrong patient", 2, "Re-released", "2026-09-08 11:00"]);
    expect(out[2]).toEqual(["2026-09-08 10:00", "", "", "0042", "Routine package", "ROUTINE", "System (package cascade)", "Followed its component's undo", "", "Still unreleased", ""]);
  });
});

describe("href / filename", () => {
  const p = { start: "2026-06-10", end: TODAY };
  it("carries the range", () => {
    expect(undoneReleasesCsvHref(p)).toBe("/api/admin/reports/undone-releases.csv?start=2026-06-10&end=2026-09-08");
    expect(undoneReleasesCsvFilename(p)).toBe("undone-releases-2026-06-10_2026-09-08.csv");
  });
});
