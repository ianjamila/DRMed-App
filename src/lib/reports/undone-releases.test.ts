import { describe, expect, it } from "vitest";
import type { SortSpec } from "@/lib/ui/table-params";
import {
  compareUndoneReleases,
  deriveUndoneRelease,
  parseUndoneReleasesParams,
  summariseUndoneReleases,
  UNDONE_RELEASES_CSV_HEADER,
  undoneReleasesCsvFilename,
  undoneReleasesCsvHref,
  undoneReleasesCsvRows,
  type AuditRow,
  type TestRequestRow,
  type UndoneRelease,
  type UndoneReleasesSortColumn,
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

describe("compareUndoneReleases", () => {
  // A distinct fixture from the one above: two resolvable staff undos (with
  // different actors and viewed-counts so direction actually moves them),
  // one system cascade, and one staff undo whose resource_id never resolved
  // (patient/test/status all null; the actor id also isn't in staffById) —
  // that last one exercises every nulls-last column at once.
  const sortStaff = new Map([
    ["u1", "Path One"],
    ["u2", "Dr. Two"],
  ]);
  const sortTrById = new Map<string, TestRequestRow>([
    [
      "t1",
      {
        id: "t1", status: "released", released_at: "2026-09-08T03:00:00Z", visit_id: "v1",
        services: { name: "CBC", code: "CBC" },
        visits: { visit_number: "0042", patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } },
      },
    ],
    [
      "h1",
      {
        id: "h1", status: "ready_for_release", released_at: null, visit_id: "v1",
        services: { name: "Routine package", code: "ROUTINE" },
        visits: { visit_number: "0042", patients: null },
      },
    ],
    [
      "t9",
      {
        id: "t9", status: "cancelled", released_at: null, visit_id: "v9",
        services: { name: "FBS", code: "FBS" },
        visits: { visit_number: "0099", patients: { first_name: "Zed", last_name: "Yu", drm_id: "DRM-9" } },
      },
    ],
  ]);

  // ids deliberately DON'T match created_at order, so a "when" sort proves it
  // is keying off the timestamp and not just returning insertion order.
  const rAna: AuditRow = {
    id: 5, created_at: "2026-09-08T04:00:00Z", actor_id: "u1", actor_type: "staff", resource_id: "t1",
    metadata: { reason: "wrong patient", viewed_count: 2 },
  };
  const rCascade: AuditRow = {
    id: 6, created_at: "2026-09-08T03:00:00Z", actor_id: null, actor_type: "system", resource_id: "h1",
    metadata: { cascaded_from: "t1" },
  };
  const rZed: AuditRow = {
    id: 4, created_at: "2026-09-08T05:00:00Z", actor_id: "u2", actor_type: "staff", resource_id: "t9",
    metadata: { reason: "duplicate order", viewed_count: 0 },
  };
  const rUnresolved: AuditRow = {
    id: 7, created_at: "2026-09-08T02:00:00Z", actor_id: "u9", actor_type: "staff", resource_id: null,
    metadata: {},
  };

  const rows: UndoneRelease[] = [rAna, rCascade, rZed, rUnresolved].map((r) =>
    deriveUndoneRelease(r, sortTrById, sortStaff),
  );

  function sortedIds(sort: SortSpec<UndoneReleasesSortColumn>): number[] {
    return [...rows].sort((a, b) => compareUndoneReleases(a, b, sort)).map((e) => e.id);
  }

  it("defaults to newest-first, tie-broken by the numeric audit_log id", () => {
    expect(sortedIds({ key: "when", dir: "desc" })).toEqual([4, 5, 6, 7]);
    // Equal timestamps still resolve ascending by id, regardless of `dir` —
    // the tie-break is not multiplied by dirMul.
    const tie = [rAna, { ...rCascade, created_at: rAna.created_at }].map((r) =>
      deriveUndoneRelease(r, sortTrById, sortStaff),
    );
    expect(tie.sort((a, b) => compareUndoneReleases(a, b, { key: "when", dir: "asc" })).map((e) => e.id)).toEqual([
      5, 6,
    ]);
  });

  it("sinks an unresolved patient to the bottom in both directions", () => {
    // Cruz, Ana < Yu, Zed alphabetically; the cascade row (no patient FK) and
    // the unresolved row both stay last, tie-broken by id.
    expect(sortedIds({ key: "patient", dir: "asc" })).toEqual([5, 4, 6, 7]);
    expect(sortedIds({ key: "patient", dir: "desc" })).toEqual([4, 5, 6, 7]);
  });

  it("sorts viewed-count numerically, with cascade and pre-tracking rows last", () => {
    expect(sortedIds({ key: "viewed", dir: "asc" })).toEqual([4, 5, 6, 7]);
    expect(sortedIds({ key: "viewed", dir: "desc" })).toEqual([5, 4, 6, 7]);
  });

  it("treats a cascade row's actor as the literal 'System' label, not a null", () => {
    // Dr. Two < Path One < System alphabetically; only the truly unresolved
    // actor (rUnresolved) sinks to the bottom.
    expect(sortedIds({ key: "by", dir: "asc" })).toEqual([4, 5, 6, 7]);
    expect(sortedIds({ key: "by", dir: "desc" })).toEqual([6, 5, 4, 7]);
  });

  it("orders outcome by its display label, with no nulls-last special-casing", () => {
    // "" (no status) < "Cancelled" < "Re-released" < "Still unreleased".
    expect(sortedIds({ key: "outcome", dir: "asc" })).toEqual([7, 4, 5, 6]);
    expect(sortedIds({ key: "outcome", dir: "desc" })).toEqual([6, 5, 4, 7]);
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
