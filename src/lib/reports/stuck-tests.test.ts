import { describe, expect, it } from "vitest";
import {
  ageDays,
  headerCandidateIsSettled,
  loadStuckTests,
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
  visits: { visit_number: "0042", payment_status: "paid", hmo_provider_id: null, patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } },
};
const header: StuckRow = {
  id: "h1", status: "ready_for_release", requested_at: "2026-09-02T02:00:00Z", assigned_to: null, visit_id: "v2",
  services: [{ code: "ROUTINE", name: "Routine package" }],
  visits: [{ visit_number: "0043", payment_status: "waived", hmo_provider_id: null, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
};
const empty: EmptyVisitRow = {
  id: "v3", visit_number: "0044", created_at: "2026-09-07T02:00:00Z", total_php: 0, payment_status: "unpaid",
  patients: { first_name: "Cy", last_name: "Ek", drm_id: "DRM-3" },
};

describe("headerCandidateIsSettled", () => {
  const withVisit = (payment_status: string, hmo_provider_id: string | null): StuckRow => ({
    ...header,
    visits: [{ visit_number: "0043", payment_status, hmo_provider_id, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
  });

  it("counts an HMO visit as settled even though it is never paid", () => {
    // The A3 case: an HMO visit's payment_status stays 'unpaid' forever, so
    // a paid/waived-only filter hid exactly the headers this report exists
    // to surface.
    expect(headerCandidateIsSettled(withVisit("unpaid", "hmo-1"))).toBe(true);
  });

  it("counts paid and waived visits as settled", () => {
    expect(headerCandidateIsSettled(withVisit("paid", null))).toBe(true);
    expect(headerCandidateIsSettled(withVisit("waived", null))).toBe(true);
  });

  it("does not count an unpaid non-HMO visit, whose header is legitimately withheld", () => {
    expect(headerCandidateIsSettled(withVisit("unpaid", null))).toBe(false);
  });

  it("does not count a row whose visit embed is missing", () => {
    expect(headerCandidateIsSettled({ ...header, visits: null })).toBe(false);
  });
});

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

// ---------------------------------------------------------------------------
// Query shape — the doctor-line exclusion lives in the PostgREST filters, so
// it is asserted on the calls the loader makes rather than on its output.
// ---------------------------------------------------------------------------

const CHAIN_METHODS = [
  "select", "eq", "in", "is", "not", "gte", "lt", "order", "range", "returns", "limit",
] as const;

interface RecordedQuery {
  table: string;
  calls: { fn: string; args: unknown[] }[];
}

/**
 * A chainable stand-in for a supabase-js builder that records every call.
 * Each method returns the same object and the object is thenable, which is
 * all `fetchAllRows` and a direct `await` need — enough to assert the SHAPE
 * of a query with no database in sight (vitest.config: pure logic only).
 */
function recordingClient() {
  const queries: RecordedQuery[] = [];
  const builderFor = (table: string) => {
    const q: RecordedQuery = { table, calls: [] };
    queries.push(q);
    const b: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej),
    };
    for (const m of CHAIN_METHODS) {
      b[m] = (...args: unknown[]) => {
        q.calls.push({ fn: m, args });
        return b;
      };
    }
    return b;
  };
  return { client: { from: builderFor }, queries };
}

const argsOf = (q: RecordedQuery, fn: string): unknown[][] =>
  q.calls.filter((c) => c.fn === fn).map((c) => c.args);

const DOCTOR_NOT_IN = ["services.kind", "in", "(doctor_consultation,doctor_procedure)"];

const runLoadStuckTests = async () => {
  const { client, queries } = recordingClient();
  await loadStuckTests(
    client as unknown as Parameters<typeof loadStuckTests>[0],
    { days: 3 },
    20_000,
    NOW,
  );
  // Every list comes back empty, so the claimer lookup makes no call and the
  // four data queries land in a fixed order.
  return {
    stuck: queries[0]!,
    orphanHeaders: queries[1]!,
    emptyVisits: queries[2]!,
    packageHeaders: queries[3]!,
    queries,
  };
};

describe("loadStuckTests query shape", () => {
  it("excludes doctor lines from the stuck list", async () => {
    const { stuck } = await runLoadStuckTests();
    expect(stuck.table).toBe("test_requests");
    expect(argsOf(stuck, "not")).toContainEqual(DOCTOR_NOT_IN);
  });

  it("enumerates the doctor kinds rather than allow-listing the lab ones", async () => {
    // An allow-list would make a newly seeded kind vanish from the report
    // silently (0126). The only `.in()` here is the status list.
    const { stuck } = await runLoadStuckTests();
    const inFilters = JSON.stringify(argsOf(stuck, "in"));
    for (const lab of ["lab_test", "lab_package", "vaccine", "home_service"]) {
      expect(inFilters).not.toContain(lab);
    }
  });

  it("keeps the stuck list's existing filters alongside the new one", async () => {
    const { stuck } = await runLoadStuckTests();
    expect(argsOf(stuck, "in")).toContainEqual([
      "status",
      ["requested", "in_progress", "result_uploaded", "ready_for_release"],
    ]);
    expect(argsOf(stuck, "eq")).toContainEqual(["is_package_header", false]);
    expect(argsOf(stuck, "is")).toContainEqual(["deleted_at", null]);
    expect(argsOf(stuck, "is")).toContainEqual(["visits.deleted_at", null]);
    expect(argsOf(stuck, "lt").map((a) => a[0])).toContain("requested_at");
  });

  it("leaves the integrity lists unfiltered — a package header is never a doctor line", async () => {
    const { orphanHeaders, emptyVisits, packageHeaders } = await runLoadStuckTests();
    expect(orphanHeaders.table).toBe("test_requests");
    expect(packageHeaders.table).toBe("test_requests");
    expect(argsOf(orphanHeaders, "eq")).toContainEqual(["is_package_header", true]);
    expect(argsOf(packageHeaders, "eq")).toContainEqual(["is_package_header", true]);
    for (const q of [orphanHeaders, emptyVisits, packageHeaders]) {
      expect(argsOf(q, "not")).not.toContainEqual(DOCTOR_NOT_IN);
    }
    // emptyVisits counts test_request ROWS per visit — a consultation-only
    // visit has a bill line and is correctly not "empty".
    expect(emptyVisits.table).toBe("visits");
    expect(argsOf(emptyVisits, "is")).toContainEqual(["lines", null]);
  });

  it("makes no claimer lookup when nothing is stuck", async () => {
    const { queries } = await runLoadStuckTests();
    expect(queries.map((q) => q.table)).toEqual([
      "test_requests",
      "test_requests",
      "visits",
      "test_requests",
    ]);
  });
});
