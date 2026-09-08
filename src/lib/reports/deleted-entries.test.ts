import { describe, expect, it } from "vitest";
import {
  DELETED_ENTRIES_CSV_HEADER,
  deletedEntriesCsvFilename,
  deletedEntriesCsvHref,
  deletedEntriesCsvRows,
  deriveDeletedEntry,
  parseDeletedEntriesParams,
  summariseDeletedEntries,
  type AuditRow,
  type TestRequestRow,
  type VisitRow,
} from "./deleted-entries";

const TODAY = "2026-09-08";

describe("parseDeletedEntriesParams", () => {
  it("defaults to the last 90 days", () => {
    expect(parseDeletedEntriesParams({}, TODAY)).toEqual({ start: "2026-06-10", end: TODAY });
  });
  it("rejects non-ISO input", () => {
    expect(parseDeletedEntriesParams({ start: "1/1/26", end: "2026-09-01" }, TODAY)).toEqual({
      start: "2026-06-10",
      end: "2026-09-01",
    });
  });
});

const visitDelete: AuditRow = {
  id: 1, created_at: "2026-09-08T02:00:00Z", actor_id: "u1", action: "visit.deleted",
  resource_type: "visit", resource_id: "v1",
  metadata: { total_php: 1500, active_test_count: 3, reason: "duplicate entry", visit_number: 42 },
};
const testRestore: AuditRow = {
  id: 2, created_at: "2026-09-07T02:00:00Z", actor_id: "u2", action: "test_request.restored",
  resource_type: "test_request", resource_id: "t1",
  metadata: { final_price_php: 350, service_name: "CBC", service_code: "CBC" },
};
const visitById = new Map<string, VisitRow>([
  ["v1", { id: "v1", visit_number: "0042", deleted_at: "2026-09-08T02:00:00Z", total_php: 1500, patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } }],
]);
const trById = new Map<string, TestRequestRow>([
  ["t1", { id: "t1", deleted_at: null, visit_id: "v9", services: { name: "CBC", code: "CBC" }, visits: { visit_number: "0009", deleted_at: null, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] } }],
]);
const staff = new Map([["u1", "Admin One"]]);

describe("deriveDeletedEntry", () => {
  it("resolves a visit delete from the visit row", () => {
    const e = deriveDeletedEntry(visitDelete, visitById, trById, staff);
    expect(e).toMatchObject({
      isDelete: true, isVisit: true, visitNumber: "0042", visitHref: "/staff/visits/v1",
      activeTestCount: 3, amount: 1500, currentlyDeleted: true, actorName: "Admin One",
      reason: "duplicate entry", serviceName: null, isPackageHeader: false,
    });
    expect(e.patient?.drm_id).toBe("DRM-1");
  });

  it("resolves a test restore via its visit, flattening array embeds", () => {
    const e = deriveDeletedEntry(testRestore, visitById, trById, staff);
    expect(e).toMatchObject({
      isDelete: false, isVisit: false, visitNumber: "0009", visitHref: "/staff/visits/v9",
      serviceName: "CBC", serviceCode: "CBC", amount: 350, currentlyDeleted: false, actorName: null,
    });
    expect(e.patient?.drm_id).toBe("DRM-2");
  });

  it("falls back to audit metadata when the row is gone", () => {
    const e = deriveDeletedEntry(visitDelete, new Map(), trById, staff);
    expect(e.visitNumber).toBe("42");
    expect(e.currentlyDeleted).toBe(false);
  });

  it("counts a surviving test line as deleted when its parent visit is", () => {
    const orphaned = new Map<string, TestRequestRow>([
      ["t1", { id: "t1", deleted_at: null, visit_id: "v9", services: { name: "CBC", code: "CBC" }, visits: { visit_number: "0009", deleted_at: "2026-09-08T00:00:00Z", patients: null } }],
    ]);
    expect(deriveDeletedEntry(testRestore, visitById, orphaned, staff).currentlyDeleted).toBe(true);
  });
});

describe("summariseDeletedEntries", () => {
  it("counts deletes, restores, still-deleted and value", () => {
    const entries = [visitDelete, testRestore].map((r) => deriveDeletedEntry(r, visitById, trById, staff));
    expect(summariseDeletedEntries(entries)).toEqual({ deleteEvents: 1, restoreEvents: 1, stillDeleted: 1, deletedValue: 1500 });
  });
});

describe("deletedEntriesCsvRows", () => {
  it("mirrors the table columns", () => {
    const entries = [visitDelete, testRestore].map((r) => deriveDeletedEntry(r, visitById, trById, staff));
    const out = deletedEntriesCsvRows(entries);
    expect(out[0]).toEqual([...DELETED_ENTRIES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08 10:00", "Deleted", "Cruz, Ana", "DRM-1", "0042", "Entire visit (3 tests)", "", "Admin One", "duplicate entry", "1500.00", "yes"]);
    expect(out[2]).toEqual(["2026-09-07 10:00", "Restored", "Dy, Ben", "DRM-2", "0009", "CBC", "CBC", "", "", "350.00", "no"]);
  });
});

describe("href / filename", () => {
  const p = { start: "2026-06-10", end: TODAY };
  it("carries the range", () => {
    expect(deletedEntriesCsvHref(p)).toBe("/api/admin/reports/deleted-entries.csv?start=2026-06-10&end=2026-09-08");
    expect(deletedEntriesCsvFilename(p)).toBe("deleted-entries-2026-06-10_2026-09-08.csv");
  });
});
