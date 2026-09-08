import { describe, expect, it } from "vitest";
import {
  ageDays,
  parseStuckTestsParams,
  STUCK_TESTS_CSV_HEADER,
  stuckTestsCsvFilename,
  stuckTestsCsvHref,
  stuckTestsCsvRows,
  type EmptyVisitRow,
  type StuckRow,
} from "./stuck-tests";

describe("parseStuckTestsParams", () => {
  it("defaults to 3 days and clamps to 1..365 whole days", () => {
    expect(parseStuckTestsParams({})).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "10.9" })).toEqual({ days: 10 });
    expect(parseStuckTestsParams({ days: "0" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "400" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "abc" })).toEqual({ days: 3 });
  });
});

describe("ageDays", () => {
  it("floors whole days from an injected now", () => {
    const now = Date.parse("2026-09-08T10:00:00Z");
    expect(ageDays("2026-09-05T11:00:00Z", now)).toBe(2);
    expect(ageDays("2026-09-05T09:00:00Z", now)).toBe(3);
  });
});

const NOW = Date.parse("2026-09-08T10:00:00Z");
const stuck: StuckRow = {
  id: "t1", status: "in_progress", requested_at: "2026-09-01T02:00:00Z", assigned_to: "u1", visit_id: "v1",
  services: { code: "CBC", name: "CBC" },
  visits: { visit_number: "0042", payment_status: "paid", patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } },
};
const header: StuckRow = {
  id: "h1", status: "ready_for_release", requested_at: "2026-09-02T02:00:00Z", assigned_to: null, visit_id: "v2",
  services: [{ code: "ROUTINE", name: "Routine package" }],
  visits: [{ visit_number: "0043", payment_status: "waived", patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
};
const empty: EmptyVisitRow = {
  id: "v3", visit_number: "0044", created_at: "2026-09-07T02:00:00Z", total_php: 0, payment_status: "unpaid",
  patients: { first_name: "Cy", last_name: "Ek", drm_id: "DRM-3" },
};

describe("stuckTestsCsvRows", () => {
  it("unions the four lists under a List column", () => {
    const out = stuckTestsCsvRows(
      { stuck: [stuck], stuckHeaders: [header], orphanHeaders: [], emptyVisits: [empty] },
      new Map([["u1", "Med Tech"]]),
      NOW,
    );
    expect(out[0]).toEqual([...STUCK_TESTS_CSV_HEADER]);
    expect(out[1]).toEqual(["Stuck test", 7, "2026-09-01 10:00", "0042", "Cruz, Ana", "DRM-1", "CBC", "CBC", "in_progress", "Med Tech", "paid", ""]);
    expect(out[2]).toEqual(["Package header not auto-released", 6, "2026-09-02 10:00", "0043", "Dy, Ben", "DRM-2", "ROUTINE", "Routine package", "ready_for_release", "", "waived", ""]);
    expect(out[3]).toEqual(["Visit with no tests", 1, "2026-09-07 10:00", "0044", "Ek, Cy", "DRM-3", "", "", "", "", "unpaid", "0.00"]);
  });
});

describe("href / filename", () => {
  it("carries the threshold", () => {
    expect(stuckTestsCsvHref({ days: 3 })).toBe("/api/admin/reports/stuck-tests.csv?days=3");
    expect(stuckTestsCsvFilename({ days: 3 }, "2026-09-08")).toBe("stuck-tests-3d-2026-09-08.csv");
  });
});
