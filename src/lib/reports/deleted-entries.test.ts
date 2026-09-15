import { describe, expect, it } from "vitest";
import {
  compareDeletedEntries,
  DELETED_ENTRIES_CSV_HEADER,
  DELETED_ENTRIES_DEFAULT_SORT,
  deletedEntriesCsvFilename,
  deletedEntriesCsvHref,
  deletedEntriesCsvRows,
  deriveDeletedEntry,
  parseDeletedEntriesParams,
  summariseDeletedEntries,
  type AuditRow,
  type DeletedEntry,
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

describe("compareDeletedEntries", () => {
  const base: DeletedEntry = {
    id: 1,
    createdAt: "2026-09-01T00:00:00Z",
    isDelete: true,
    isVisit: true,
    patient: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" },
    visitNumber: "0042",
    visitHref: "/staff/visits/v1",
    activeTestCount: 3,
    serviceName: null,
    serviceCode: null,
    isPackageHeader: false,
    actorName: "Admin One",
    reason: "duplicate entry",
    amount: 1500,
    currentlyDeleted: true,
  };
  function entry(overrides: Partial<DeletedEntry>): DeletedEntry {
    return { ...base, ...overrides };
  }

  it("defaults to most-recent-first on `when`, tie-broken by the numeric audit_log id", () => {
    const older = entry({ id: 5, createdAt: "2026-09-01T00:00:00Z" });
    const newer = entry({ id: 2, createdAt: "2026-09-02T00:00:00Z" });
    const sorted = [older, newer].sort((a, b) =>
      compareDeletedEntries(a, b, DELETED_ENTRIES_DEFAULT_SORT),
    );
    expect(sorted.map((e) => e.id)).toEqual([2, 5]);

    // Same timestamp -> falls through to the id tie-break. audit_log.id is a
    // number here, unlike the uuid ids everywhere else in this batch, so the
    // tie-break must be arithmetic, not localeCompare.
    const sameTimeHigh = entry({ id: 9, createdAt: "2026-09-01T00:00:00Z" });
    const sameTimeLow = entry({ id: 3, createdAt: "2026-09-01T00:00:00Z" });
    expect(
      compareDeletedEntries(sameTimeHigh, sameTimeLow, DELETED_ENTRIES_DEFAULT_SORT),
    ).toBeGreaterThan(0);
  });

  it("`event` puts deletes ahead of restores when descending, and flips when ascending", () => {
    const del = entry({ id: 1, isDelete: true });
    const restore = entry({ id: 2, isDelete: false });
    expect(compareDeletedEntries(del, restore, { key: "event", dir: "desc" })).toBeLessThan(0);
    expect(compareDeletedEntries(del, restore, { key: "event", dir: "asc" })).toBeGreaterThan(0);
  });

  it("`patient` sorts by last, first and sinks a missing patient regardless of direction", () => {
    const withPatient = entry({
      id: 1,
      patient: { first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" },
    });
    const noPatient = entry({ id: 2, patient: null });
    expect(compareDeletedEntries(withPatient, noPatient, { key: "patient", dir: "asc" })).toBeLessThan(0);
    expect(compareDeletedEntries(withPatient, noPatient, { key: "patient", dir: "desc" })).toBeLessThan(0);
  });

  it("`visit` compares visit numbers as text (never Number()) and sinks a missing one", () => {
    // "H-1001" alongside "0042" is exactly the historical-import mix prod
    // carries — Number() on the former is NaN, which would silently disable
    // this comparator's id tie-break.
    const historical = entry({ id: 1, visitNumber: "H-1001" });
    const numeric = entry({ id: 2, visitNumber: "0042" });
    const noVisit = entry({ id: 3, visitNumber: null });
    expect(compareDeletedEntries(historical, numeric, { key: "visit", dir: "asc" })).toBe(
      "H-1001".localeCompare("0042"),
    );
    expect(compareDeletedEntries(numeric, noVisit, { key: "visit", dir: "desc" })).toBeLessThan(0);
  });

  it('`what` reads "Entire visit" for a visit delete and the service name otherwise, null last', () => {
    const visitDelete = entry({ id: 1, isVisit: true, serviceName: null });
    const testDelete = entry({ id: 2, isVisit: false, serviceName: "CBC" });
    const unknownService = entry({ id: 3, isVisit: false, serviceName: null });
    expect(
      compareDeletedEntries(testDelete, visitDelete, { key: "what", dir: "asc" }),
    ).toBeLessThan(0); // "CBC" < "Entire visit"
    expect(
      compareDeletedEntries(visitDelete, unknownService, { key: "what", dir: "asc" }),
    ).toBeLessThan(0); // a resolved value always beats a null one
  });

  it("`by` sinks an unresolved actor regardless of direction", () => {
    const named = entry({ id: 1, actorName: "Admin One" });
    const unresolved = entry({ id: 2, actorName: null });
    expect(compareDeletedEntries(named, unresolved, { key: "by", dir: "desc" })).toBeLessThan(0);
    expect(compareDeletedEntries(named, unresolved, { key: "by", dir: "asc" })).toBeLessThan(0);
  });

  it("`amount` compares numerically and sinks a null amount regardless of direction", () => {
    const small = entry({ id: 1, amount: 100 });
    const large = entry({ id: 2, amount: 1500 });
    const noAmount = entry({ id: 3, amount: null });
    expect(compareDeletedEntries(small, large, { key: "amount", dir: "asc" })).toBeLessThan(0);
    expect(compareDeletedEntries(large, small, { key: "amount", dir: "desc" })).toBeLessThan(0);
    expect(compareDeletedEntries(small, noAmount, { key: "amount", dir: "asc" })).toBeLessThan(0);
    expect(compareDeletedEntries(small, noAmount, { key: "amount", dir: "desc" })).toBeLessThan(0);
  });

  it("`outcome` puts still-deleted rows ahead of restored ones when descending", () => {
    const stillDeleted = entry({ id: 1, currentlyDeleted: true });
    const backInQueue = entry({ id: 2, currentlyDeleted: false });
    expect(
      compareDeletedEntries(stillDeleted, backInQueue, { key: "outcome", dir: "desc" }),
    ).toBeLessThan(0);
    expect(
      compareDeletedEntries(stillDeleted, backInQueue, { key: "outcome", dir: "asc" }),
    ).toBeGreaterThan(0);
  });
});
